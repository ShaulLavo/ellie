package chatui

import (
	"context"
	"log/slog"
	"math"
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

	body, err := connectSSE(ctx, s.baseURL, s.sessionID)
	if err != nil {
		return err
	}
	defer body.Close()

	// Connected successfully — reset attempts
	s.mu.Lock()
	s.reconnectAttempts = 0
	s.mu.Unlock()
	send(sseStateMsg{State: StateConnected})

	// Use the shared SSE reader; convert sseEvent → tea.Msg.
	readErr := readSSEStream(ctx, body, func(ev sseEvent) {
		if ev.Err != nil {
			slog.Error("SSE event error", "error", ev.Err)
			return
		}

		switch ev.Kind {
		case "snapshot":
			s.mu.Lock()
			for _, row := range ev.Rows {
				if row.Seq > s.lastSeq {
					s.lastSeq = row.Seq
				}
			}
			s.mu.Unlock()
			send(sseSnapshotMsg{Events: ev.Rows})

		case "append":
			s.mu.Lock()
			if ev.Row.Seq > s.lastSeq {
				s.lastSeq = ev.Row.Seq
			}
			s.mu.Unlock()
			send(sseAppendMsg{Event: ev.Row})

		case "update":
			send(sseUpdateMsg{Event: ev.Row})
		}
	})

	if readErr != nil {
		return readErr
	}
	return nil
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
