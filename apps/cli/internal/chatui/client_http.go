package chatui

import (
	"bytes"
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
func (c *HTTPClient) GetStatus() (*StatusResponse, error) {
	resp, err := c.client.Get(c.baseURL + "/api/status")
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
func (c *HTTPClient) ListSessions() ([]SessionEntry, error) {
	resp, err := c.client.Get(c.baseURL + "/chat/sessions")
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
func (c *HTTPClient) GetCurrentSession() (*SessionEntry, error) {
	resp, err := c.client.Get(c.baseURL + "/chat/sessions/current")
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
func (c *HTTPClient) SendMessage(sessionID, content string) error {
	body, _ := json.Marshal(map[string]string{
		"content": content,
	})
	resp, err := c.client.Post(
		c.baseURL+"/chat/"+sessionID+"/messages",
		"application/json",
		bytes.NewReader(body),
	)
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
func (c *HTTPClient) ClearSession(sessionID string) error {
	resp, err := c.client.Post(
		c.baseURL+"/chat/"+sessionID+"/clear",
		"application/json",
		nil,
	)
	if err != nil {
		return fmt.Errorf("clear session failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("clear session returned %d", resp.StatusCode)
	}
	return nil
}
