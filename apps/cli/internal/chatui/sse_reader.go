package chatui

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// sseEvent is a parsed SSE event used by both the TUI SSE client and
// the one-shot reader.
type sseEvent struct {
	Kind      string     // "snapshot", "append", "update"
	Row       EventRow   // single event (append/update)
	Rows      []EventRow // multiple events (snapshot)
	SessionID string     // resolved session ID (snapshot only)
	Err       error      // connection/parse error
}

// connectSSE opens an SSE connection and returns the response body.
// The caller is responsible for closing it.
func connectSSE(ctx context.Context, baseURL, sessionID string) (io.ReadCloser, error) {
	url := fmt.Sprintf("%s/api/chat/%s/events/sse", baseURL, sessionID)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("SSE connect: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("SSE returned %d", resp.StatusCode)
	}

	return resp.Body, nil
}

// readSSEStream reads SSE events from a reader and calls onEvent for
// each parsed event. It blocks until the stream ends, ctx is cancelled,
// or an error occurs. Returns nil on clean EOF.
func readSSEStream(ctx context.Context, body io.Reader, onEvent func(sseEvent)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	var eventType string
	var dataLines []string

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			// End of event — dispatch
			if eventType != "" && len(dataLines) > 0 {
				data := strings.Join(dataLines, "\n")
				dispatchSSEEvent(eventType, data, onEvent)
			}
			eventType = ""
			dataLines = dataLines[:0]
			continue
		}

		if strings.HasPrefix(line, "event:") {
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(line, "data:"))
		}
		// Ignore id:, retry:, comments (:)
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return nil // context cancelled — clean shutdown
		}
		return fmt.Errorf("SSE read: %w", err)
	}

	return nil // clean EOF
}

// snapshotData matches the server's snapshot envelope:
//
//	{ sessionId: string, events: EventRow[] }
type snapshotData struct {
	SessionID string     `json:"sessionId"`
	Events    []EventRow `json:"events"`
}

// dispatchSSEEvent parses the JSON data for a given SSE event type and
// calls onEvent with the result. Handles: snapshot, append, update,
// heartbeat. Rotation is handled via connection abort (no reset event).
func dispatchSSEEvent(eventType, data string, onEvent func(sseEvent)) {
	switch eventType {
	case "snapshot":
		// Try new format: { sessionId, events } first, then plain array.
		var snap snapshotData
		if err := json.Unmarshal([]byte(data), &snap); err == nil && snap.Events != nil {
			onEvent(sseEvent{Kind: "snapshot", Rows: snap.Events, SessionID: snap.SessionID})
			return
		}
		var rows []EventRow
		if err := json.Unmarshal([]byte(data), &rows); err != nil {
			onEvent(sseEvent{Err: fmt.Errorf("parse snapshot: %w", err)})
			return
		}
		onEvent(sseEvent{Kind: "snapshot", Rows: rows})

	case "append":
		var row EventRow
		if err := json.Unmarshal([]byte(data), &row); err != nil {
			onEvent(sseEvent{Err: fmt.Errorf("parse append: %w", err)})
			return
		}
		onEvent(sseEvent{Kind: "append", Row: row})

	case "update":
		var row EventRow
		if err := json.Unmarshal([]byte(data), &row); err != nil {
			onEvent(sseEvent{Err: fmt.Errorf("parse update: %w", err)})
			return
		}
		onEvent(sseEvent{Kind: "update", Row: row})

	case "heartbeat":
		// Ignored — keep-alive signal
	}
}
