package chatui

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HTTPClient handles REST API calls to the Ellie server.
type HTTPClient struct {
	baseURL      string
	client       *http.Client // short-timeout client for API calls
	uploadClient *http.Client // no timeout for file uploads (controlled via ctx)
}

// NewHTTPClient creates a REST client pointing at baseURL.
func NewHTTPClient(baseURL string) *HTTPClient {
	return &HTTPClient{
		baseURL:      baseURL,
		client:       &http.Client{Timeout: 10 * time.Second},
		uploadClient: &http.Client{},
	}
}

// GetStatus checks server health via GET /api/status.
func (c *HTTPClient) GetStatus(ctx context.Context) (*StatusResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/status", nil)
	if err != nil {
		return nil, fmt.Errorf("create status request: %w", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("status request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status returned %d", resp.StatusCode)
	}
	var out StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode status: %w", err)
	}
	return &out, nil
}

// ListSessions fetches GET /api/chat/sessions.
func (c *HTTPClient) ListSessions(ctx context.Context) ([]SessionEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/chat/sessions", nil)
	if err != nil {
		return nil, fmt.Errorf("create sessions request: %w", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list sessions failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list sessions returned %d", resp.StatusCode)
	}
	var out []SessionEntry
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode sessions: %w", err)
	}
	return out, nil
}

// GetCurrentSession fetches GET /api/chat/sessions/current (resolves to the current session entry).
func (c *HTTPClient) GetCurrentSession(ctx context.Context) (*SessionEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/chat/sessions/current", nil)
	if err != nil {
		return nil, fmt.Errorf("create current session request: %w", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get current session failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("get current session returned %d: %s", resp.StatusCode, body)
	}
	var out SessionEntry
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode current session: %w", err)
	}
	return &out, nil
}

// SendMessage posts a user message to the current session, optionally with attachments.
func (c *HTTPClient) SendMessage(ctx context.Context, sessionID, content string, attachments []AttachmentResult) error {
	payload := map[string]interface{}{
		"content": content,
	}
	if len(attachments) > 0 {
		payload["attachments"] = attachments
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/api/chat/"+sessionID+"/messages", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create send request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("send message failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("send message returned %d: %s", resp.StatusCode, respBody)
	}
	return nil
}

// UploadFile uploads a local file via the TUS protocol and returns the result.
// Two-step: POST to create the upload, PATCH to send the file body.
func (c *HTTPClient) UploadFile(ctx context.Context, filePath string) (AttachmentResult, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("stat file: %w", err)
	}

	name := filepath.Base(filePath)
	mime := detectMime(name)

	// Encode TUS metadata: "filename <b64>,mimeType <b64>"
	meta := fmt.Sprintf("filename %s,mimeType %s",
		base64.StdEncoding.EncodeToString([]byte(name)),
		base64.StdEncoding.EncodeToString([]byte(mime)),
	)

	tusURL := strings.TrimRight(c.baseURL, "/") + "/api/uploads"

	// 1. POST — create upload
	createReq, err := http.NewRequestWithContext(ctx, "POST", tusURL, nil)
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("create upload request: %w", err)
	}
	createReq.Header.Set("Tus-Resumable", "1.0.0")
	createReq.Header.Set("Upload-Length", fmt.Sprintf("%d", info.Size()))
	createReq.Header.Set("Upload-Metadata", meta)
	createReq.Header.Set("Content-Length", "0")

	createResp, err := c.uploadClient.Do(createReq)
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("upload create failed: %w", err)
	}
	defer createResp.Body.Close()
	if createResp.StatusCode < 200 || createResp.StatusCode >= 300 {
		return AttachmentResult{}, fmt.Errorf("upload create returned %d", createResp.StatusCode)
	}

	location := createResp.Header.Get("Location")
	if location == "" {
		return AttachmentResult{}, fmt.Errorf("upload create: no Location header")
	}

	// Extract uploadId from location path
	parts := strings.Split(location, "/")
	uploadID := parts[len(parts)-1]

	// Build absolute PATCH URL
	patchURL := location
	if !strings.HasPrefix(patchURL, "http") {
		patchURL = strings.TrimRight(c.baseURL, "/") + patchURL
	}

	// 2. PATCH — send file body
	patchReq, err := http.NewRequestWithContext(ctx, "PATCH", patchURL, f)
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("create patch request: %w", err)
	}
	patchReq.Header.Set("Tus-Resumable", "1.0.0")
	patchReq.Header.Set("Upload-Offset", "0")
	patchReq.Header.Set("Content-Type", "application/offset+octet-stream")

	patchResp, err := c.uploadClient.Do(patchReq)
	if err != nil {
		return AttachmentResult{}, fmt.Errorf("upload patch failed: %w", err)
	}
	defer patchResp.Body.Close()
	if patchResp.StatusCode < 200 || patchResp.StatusCode >= 300 {
		return AttachmentResult{}, fmt.Errorf("upload patch returned %d", patchResp.StatusCode)
	}

	return AttachmentResult{
		UploadID: uploadID,
		Mime:     mime,
		Size:     info.Size(),
		Name:     name,
	}, nil
}

// DownloadMedia fetches raw media bytes from /api/uploads-rpc/:uploadId/content.
func (c *HTTPClient) DownloadMedia(ctx context.Context, uploadID string) ([]byte, error) {
	url := c.baseURL + "/api/uploads-rpc/" + uploadID + "/content"
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create download request: %w", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download media failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download media returned %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read media body: %w", err)
	}
	return data, nil
}

// ClearSession clears the current session via POST /api/chat/:sessionId/clear.
func (c *HTTPClient) ClearSession(ctx context.Context, sessionID string) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/api/chat/"+sessionID+"/clear", nil)
	if err != nil {
		return fmt.Errorf("create clear request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("clear session failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("clear session returned %d", resp.StatusCode)
	}
	return nil
}
