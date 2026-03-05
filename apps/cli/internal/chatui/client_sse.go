package chatui

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
)

// SSE message types sent by the Bubble Tea program loop.
type (
	sseSnapshotMsg struct{ Events []EventRow }
	sseAppendMsg   struct{ Event EventRow }
	sseUpdateMsg   struct{ Event EventRow }
	sseStateMsg    struct{ State ConnectionState }
	sseErrorMsg    struct{ Message string }
)

// SSEClient connects to the Ellie SSE endpoint and fans events into a
// Bubble Tea program via tea.Cmd returns from a subscription goroutine.
type SSEClient struct {
	baseURL   string
	sessionID string

	mu                sync.Mutex
	lastSeq           int
	reconnectAttempts int
	disposed          bool
	cancelFn          context.CancelFunc
	sendFn            func(tea.Msg) // stored from first RunLoop call
}

const (
	maxReconnectAttempts = 10
	baseReconnectDelay   = 1 * time.Second
	maxReconnectDelay    = 30 * time.Second
)

// NewSSEClient creates an SSE client for the given session.
func NewSSEClient(baseURL, sessionID string) *SSEClient {
	return &SSEClient{
		baseURL:   baseURL,
		sessionID: sessionID,
	}
}

// Subscribe starts the SSE connection loop.  It returns a tea.Cmd that
// should be invoked once (in Init or on a connect action). The returned
// command runs a goroutine that pushes messages into the program.
func (s *SSEClient) Subscribe() tea.Cmd {
	return func() tea.Msg {
		// The first message signals "connecting"
		return sseStateMsg{State: StateConnecting}
	}
}

// RunLoop is a long-lived goroutine that maintains the SSE connection.
// It sends messages to the provided channel, which the model reads from.
func (s *SSEClient) RunLoop(ctx context.Context, send func(tea.Msg)) {
	s.mu.Lock()
	s.sendFn = send
	s.disposed = false
	s.mu.Unlock()

	for {
		if ctx.Err() != nil {
			return
		}

		s.mu.Lock()
		if s.disposed {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()

		send(sseStateMsg{State: StateConnecting})

		err := s.connectOnce(ctx, send)
		if ctx.Err() != nil {
			return
		}

		s.mu.Lock()
		if s.disposed {
			s.mu.Unlock()
			return
		}
		s.reconnectAttempts++
		attempts := s.reconnectAttempts
		s.mu.Unlock()

		if err != nil {
			slog.Debug("SSE connection error", "error", err, "attempt", attempts)
		}

		if attempts >= maxReconnectAttempts {
			send(sseStateMsg{State: StateError})
			send(sseErrorMsg{Message: "Connection lost after max retries"})
			return
		}

		delay := baseReconnectDelay * time.Duration(math.Pow(2, float64(attempts-1)))
		if delay > maxReconnectDelay {
			delay = maxReconnectDelay
		}

		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
	}
}

// connectOnce opens a single SSE connection, reads events until EOF or error.
func (s *SSEClient) connectOnce(ctx context.Context, send func(tea.Msg)) error {
	// Create child context so Disconnect() can abort in-flight reads.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	s.mu.Lock()
	s.cancelFn = cancel
	s.mu.Unlock()

	// Always request the full snapshot (no afterSeq) so handleSnapshot
	// receives the complete event history and doesn't lose messages on
	// reconnect. The server streams only new events after the snapshot.
	url := fmt.Sprintf("%s/chat/%s/events/sse", s.baseURL, s.sessionID)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("SSE connect: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("SSE returned %d", resp.StatusCode)
	}

	// Connected successfully — reset attempts
	s.mu.Lock()
	s.reconnectAttempts = 0
	s.mu.Unlock()
	send(sseStateMsg{State: StateConnected})

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	var eventType string
	var dataLines []string

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			// End of event — dispatch
			if eventType != "" && len(dataLines) > 0 {
				data := strings.Join(dataLines, "\n")
				s.dispatchEvent(eventType, data, send)
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
		return fmt.Errorf("SSE read: %w", err)
	}

	return fmt.Errorf("SSE stream ended")
}

func (s *SSEClient) dispatchEvent(eventType, data string, send func(tea.Msg)) {
	switch eventType {
	case "snapshot":
		var events []EventRow
		if err := json.Unmarshal([]byte(data), &events); err != nil {
			slog.Error("Failed to parse SSE snapshot", "error", err)
			return
		}
		s.mu.Lock()
		for _, ev := range events {
			if ev.Seq > s.lastSeq {
				s.lastSeq = ev.Seq
			}
		}
		s.mu.Unlock()
		send(sseSnapshotMsg{Events: events})

	case "append":
		var ev EventRow
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			slog.Error("Failed to parse SSE append", "error", err)
			return
		}
		s.mu.Lock()
		if ev.Seq > s.lastSeq {
			s.lastSeq = ev.Seq
		}
		s.mu.Unlock()
		send(sseAppendMsg{Event: ev})

	case "update":
		var ev EventRow
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			slog.Error("Failed to parse SSE update", "error", err)
			return
		}
		// No lastSeq update for updates — seq was set at INSERT time
		send(sseUpdateMsg{Event: ev})

	default:
		slog.Debug("Unknown SSE event type", "type", eventType)
	}
}

// Disconnect stops the SSE client.
func (s *SSEClient) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disposed = true
	if s.cancelFn != nil {
		s.cancelFn()
	}
}

// ResetRetry resets the reconnect counter for manual retry.
func (s *SSEClient) ResetRetry() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reconnectAttempts = 0
}
