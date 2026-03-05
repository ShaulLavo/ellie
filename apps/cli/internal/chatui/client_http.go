package chatui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// HTTPClient handles REST API calls to the Ellie server.
type HTTPClient struct {
	baseURL string
	client  *http.Client
}

// NewHTTPClient creates a REST client pointing at baseURL.
func NewHTTPClient(baseURL string) *HTTPClient {
	return &HTTPClient{
		baseURL: baseURL,
		client:  &http.Client{Timeout: 10 * time.Second},
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

// ListSessions fetches GET /chat/sessions.
func (c *HTTPClient) ListSessions(ctx context.Context) ([]SessionEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/chat/sessions", nil)
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

// GetCurrentSession fetches GET /chat/sessions/current (resolves to the current session entry).
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

// SendMessage posts a user message to the current session.
func (c *HTTPClient) SendMessage(ctx context.Context, sessionID, content string) error {
	body, _ := json.Marshal(map[string]string{
		"content": content,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/chat/"+sessionID+"/messages", bytes.NewReader(body))
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

// ClearSession clears the current session via POST /chat/:sessionId/clear.
func (c *HTTPClient) ClearSession(ctx context.Context, sessionID string) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/chat/"+sessionID+"/clear", nil)
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
