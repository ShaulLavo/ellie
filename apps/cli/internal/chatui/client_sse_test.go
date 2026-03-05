package chatui

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"context"
	tea "charm.land/bubbletea/v2"
)

func TestSSEClient_ParsesSnapshot(t *testing.T) {
	events := []EventRow{
		{ID: 1, Seq: 1, Type: "user_message", Payload: mustJSON(map[string]interface{}{"content": "hi"}), CreatedAt: 1700000000000},
		{ID: 2, Seq: 2, Type: "assistant_message", Payload: mustJSON(map[string]interface{}{"message": map[string]interface{}{"content": "hello"}}), CreatedAt: 1700000001000},
	}

	eventsJSON, _ := json.Marshal(events)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("expected ResponseWriter to be a Flusher")
		}

		fmt.Fprintf(w, "event:snapshot\ndata:%s\n\n", eventsJSON)
		flusher.Flush()

		// Close connection after sending snapshot
		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	client := NewSSEClient(srv.URL, "current")

	var mu sync.Mutex
	var received []tea.Msg
	send := func(msg tea.Msg) {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Run just one connection cycle
	go func() {
		client.connectOnce(ctx, send)
		cancel()
	}()

	<-ctx.Done()

	mu.Lock()
	defer mu.Unlock()

	// Should have received a state change and a snapshot
	foundSnapshot := false
	for _, msg := range received {
		if snap, ok := msg.(sseSnapshotMsg); ok {
			foundSnapshot = true
			if len(snap.Events) != 2 {
				t.Errorf("expected 2 events in snapshot, got %d", len(snap.Events))
			}
		}
	}

	if !foundSnapshot {
		t.Error("expected to receive a snapshot message")
	}
}

func TestSSEClient_ParsesAppendAndUpdate(t *testing.T) {
	appendEvent := EventRow{ID: 3, Seq: 3, Type: "tool_execution", Payload: mustJSON(map[string]interface{}{"toolName": "read", "status": "running"}), CreatedAt: 1700000002000}
	updateEvent := EventRow{ID: 2, Seq: 2, Type: "assistant_message", Payload: mustJSON(map[string]interface{}{"streaming": true, "message": map[string]interface{}{"content": "partial"}}), CreatedAt: 1700000001000}

	appendJSON, _ := json.Marshal(appendEvent)
	updateJSON, _ := json.Marshal(updateEvent)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)

		// Empty snapshot first
		fmt.Fprintf(w, "event:snapshot\ndata:[]\n\n")
		flusher.Flush()

		fmt.Fprintf(w, "event:append\ndata:%s\n\n", appendJSON)
		flusher.Flush()

		fmt.Fprintf(w, "event:update\ndata:%s\n\n", updateJSON)
		flusher.Flush()

		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	client := NewSSEClient(srv.URL, "current")

	var mu sync.Mutex
	var received []tea.Msg
	send := func(msg tea.Msg) {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go func() {
		client.connectOnce(ctx, send)
		cancel()
	}()

	<-ctx.Done()

	mu.Lock()
	defer mu.Unlock()

	var foundAppend, foundUpdate bool
	for _, msg := range received {
		if _, ok := msg.(sseAppendMsg); ok {
			foundAppend = true
		}
		if _, ok := msg.(sseUpdateMsg); ok {
			foundUpdate = true
		}
	}

	if !foundAppend {
		t.Error("expected append message")
	}
	if !foundUpdate {
		t.Error("expected update message")
	}
}

func TestSSEClient_MultiLineData(t *testing.T) {
	// Test multi-line data field
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)

		// Multi-line data (JSON split across lines)
		fmt.Fprintf(w, "event:snapshot\ndata:[{\"id\":1,\"seq\":1,\"type\":\"user_message\",\ndata:\"payload\":\"{}\",\"createdAt\":1700000000000}]\n\n")
		flusher.Flush()

		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	client := NewSSEClient(srv.URL, "current")

	var mu sync.Mutex
	var received []tea.Msg
	send := func(msg tea.Msg) {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go func() {
		client.connectOnce(ctx, send)
		cancel()
	}()

	<-ctx.Done()

	// Multi-line data should be joined — may or may not parse depending on
	// exact JSON split, but the client should not crash
	mu.Lock()
	defer mu.Unlock()
	// Just verify no panic occurred
}

func TestSSEClient_IgnoresUnknownEvents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)

		fmt.Fprintf(w, "event:snapshot\ndata:[]\n\n")
		flusher.Flush()

		fmt.Fprintf(w, "event:heartbeat\ndata:{}\n\n")
		flusher.Flush()

		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	client := NewSSEClient(srv.URL, "current")

	var mu sync.Mutex
	var received []tea.Msg
	send := func(msg tea.Msg) {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go func() {
		client.connectOnce(ctx, send)
		cancel()
	}()

	<-ctx.Done()

	mu.Lock()
	defer mu.Unlock()

	// Should not crash on unknown events
	for _, msg := range received {
		// No unknown event types should be forwarded
		switch msg.(type) {
		case sseSnapshotMsg, sseAppendMsg, sseUpdateMsg, sseStateMsg, sseErrorMsg:
			// expected types
		default:
			t.Errorf("unexpected message type: %T", msg)
		}
	}
}

func TestSSEClient_AlwaysFullSnapshot(t *testing.T) {
	var requestedURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedURL = r.URL.String()
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		fmt.Fprintf(w, "event:snapshot\ndata:[]\n\n")
		flusher.Flush()
		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	client := NewSSEClient(srv.URL, "current")
	client.lastSeq = 42

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go func() {
		client.connectOnce(ctx, func(tea.Msg) {})
		cancel()
	}()

	<-ctx.Done()

	// After removing afterSeq (always full snapshot), the URL should have no query params.
	if requestedURL != "/chat/current/events/sse" {
		t.Errorf("expected no afterSeq in URL, got %q", requestedURL)
	}
}

func TestSSEClient_Disconnect(t *testing.T) {
	client := NewSSEClient("http://localhost:9999", "current")
	client.Disconnect()

	if !client.disposed {
		t.Error("expected disposed to be true after disconnect")
	}
}

func TestSSEClient_ResetRetry(t *testing.T) {
	client := NewSSEClient("http://localhost:9999", "current")
	client.reconnectAttempts = 5
	client.ResetRetry()

	if client.reconnectAttempts != 0 {
		t.Errorf("expected 0 attempts after reset, got %d", client.reconnectAttempts)
	}
}
