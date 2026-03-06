package chatui

import (
	"encoding/json"
	"testing"
)

func mustJSON(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestEventToStored_AssistantMessage(t *testing.T) {
	row := EventRow{
		ID:        1,
		SessionID: "sess-1",
		Seq:       10,
		Type:      "assistant_message",
		Payload: mustJSON(map[string]interface{}{
			"streaming": false,
			"message": map[string]interface{}{
				"content": []interface{}{
					map[string]interface{}{"type": "text", "text": "Hello world"},
				},
				"model":    "claude-sonnet-4-20250514",
				"provider": "anthropic",
			},
		}),
		CreatedAt: 1700000000000,
	}

	msg := EventToStored(row)

	if msg.ID != "1" {
		t.Errorf("expected ID '1', got %q", msg.ID)
	}
	if msg.Text != "Hello world" {
		t.Errorf("expected text 'Hello world', got %q", msg.Text)
	}
	if msg.Sender != SenderAgent {
		t.Errorf("expected sender 'agent', got %q", msg.Sender)
	}
	if len(msg.Parts) != 1 || msg.Parts[0].Type != PartText {
		t.Errorf("expected 1 text part, got %d parts", len(msg.Parts))
	}
}

func TestEventToStored_AssistantMessage_Streaming(t *testing.T) {
	row := EventRow{
		ID:   2,
		Seq:  11,
		Type: "assistant_message",
		Payload: mustJSON(map[string]interface{}{
			"streaming": true,
			"message": map[string]interface{}{
				"content": []interface{}{
					map[string]interface{}{"type": "text", "text": "Partial"},
				},
			},
		}),
		CreatedAt: 1700000001000,
	}

	msg := EventToStored(row)
	if msg.Text != "Partial" {
		t.Errorf("expected 'Partial', got %q", msg.Text)
	}
}

func TestEventToStored_AssistantMessage_WithThinking(t *testing.T) {
	row := EventRow{
		ID:   3,
		Seq:  12,
		Type: "assistant_message",
		Payload: mustJSON(map[string]interface{}{
			"message": map[string]interface{}{
				"content": []interface{}{
					map[string]interface{}{"type": "thinking", "text": "Let me think about this..."},
					map[string]interface{}{"type": "text", "text": "Here is my answer"},
				},
			},
		}),
		CreatedAt: 1700000002000,
	}

	msg := EventToStored(row)
	if msg.Text != "Here is my answer" {
		t.Errorf("expected 'Here is my answer', got %q", msg.Text)
	}
	if msg.Thinking != "Let me think about this..." {
		t.Errorf("expected thinking text, got %q", msg.Thinking)
	}
	// Thinking parts should be filtered out
	for _, p := range msg.Parts {
		if p.Type == PartThinking {
			t.Error("thinking parts should be filtered from Parts")
		}
	}
}

func TestEventToStored_ToolExecution_Running(t *testing.T) {
	row := EventRow{
		ID:   4,
		Seq:  13,
		Type: "tool_execution",
		Payload: mustJSON(map[string]interface{}{
			"status":     "running",
			"toolName":   "read_file",
			"toolCallId": "tc-1",
			"args":       map[string]interface{}{"path": "/foo/bar.go"},
		}),
		CreatedAt: 1700000003000,
	}

	msg := EventToStored(row)
	if len(msg.Parts) != 1 {
		t.Fatalf("expected 1 part, got %d", len(msg.Parts))
	}
	if msg.Parts[0].Type != PartToolCall {
		t.Errorf("expected tool-call, got %s", msg.Parts[0].Type)
	}
	if msg.Parts[0].Name != "read_file" {
		t.Errorf("expected name 'read_file', got %q", msg.Parts[0].Name)
	}
	if msg.Parts[0].ToolCallID != "tc-1" {
		t.Errorf("expected toolCallId 'tc-1', got %q", msg.Parts[0].ToolCallID)
	}
}

func TestEventToStored_ToolExecution_Complete(t *testing.T) {
	row := EventRow{
		ID:   5,
		Seq:  14,
		Type: "tool_execution",
		Payload: mustJSON(map[string]interface{}{
			"status":     "complete",
			"toolName":   "read_file",
			"toolCallId": "tc-1",
			"result": map[string]interface{}{
				"content": []interface{}{
					map[string]interface{}{"type": "text", "text": "file contents here"},
				},
			},
		}),
		CreatedAt: 1700000004000,
	}

	msg := EventToStored(row)
	if len(msg.Parts) != 1 {
		t.Fatalf("expected 1 part, got %d", len(msg.Parts))
	}
	if msg.Parts[0].Type != PartToolCall {
		t.Errorf("expected tool-call with embedded result, got %s", msg.Parts[0].Type)
	}
	if msg.Parts[0].Result != "file contents here" {
		t.Errorf("expected result text, got %q", msg.Parts[0].Result)
	}
}

func TestEventToStored_ToolExecution_Error(t *testing.T) {
	row := EventRow{
		ID:   6,
		Seq:  15,
		Type: "tool_execution",
		Payload: mustJSON(map[string]interface{}{
			"status":     "error",
			"toolName":   "write_file",
			"toolCallId": "tc-2",
			"result": map[string]interface{}{
				"content": []interface{}{
					map[string]interface{}{"type": "text", "text": "permission denied"},
				},
			},
		}),
		CreatedAt: 1700000005000,
	}

	msg := EventToStored(row)
	if msg.Parts[0].Type != PartToolCall {
		t.Errorf("expected tool-call with embedded result for error status, got %s", msg.Parts[0].Type)
	}
}

func TestEventToStored_MemoryRecall(t *testing.T) {
	row := EventRow{
		ID:   7,
		Seq:  16,
		Type: "memory_recall",
		Payload: mustJSON(map[string]interface{}{
			"parts": []interface{}{
				map[string]interface{}{"type": "memory", "text": "User prefers Go", "count": 3},
			},
		}),
		CreatedAt: 1700000006000,
	}

	msg := EventToStored(row)
	if msg.Sender != SenderMemory {
		t.Errorf("expected sender 'memory', got %q", msg.Sender)
	}
}

func TestEventToStored_Error(t *testing.T) {
	row := EventRow{
		ID:   8,
		Seq:  17,
		Type: "error",
		Payload: mustJSON(map[string]interface{}{
			"message": "Something went wrong",
		}),
		CreatedAt: 1700000007000,
	}

	msg := EventToStored(row)
	if msg.Text != "Something went wrong" {
		t.Errorf("expected error text, got %q", msg.Text)
	}
	if msg.Sender != SenderAgent {
		t.Errorf("expected sender 'agent' for error, got %q", msg.Sender)
	}
}

func TestEventToStored_UserMessage(t *testing.T) {
	row := EventRow{
		ID:   9,
		Seq:  18,
		Type: "user_message",
		Payload: mustJSON(map[string]interface{}{
			"content": "Hello from user",
			"role":    "user",
		}),
		CreatedAt: 1700000008000,
	}

	msg := EventToStored(row)
	if msg.Sender != SenderUser {
		t.Errorf("expected sender 'user', got %q", msg.Sender)
	}
	if msg.Text != "Hello from user" {
		t.Errorf("expected text, got %q", msg.Text)
	}
}

func TestEventToStored_InvalidPayload(t *testing.T) {
	row := EventRow{
		ID:        10,
		Seq:       19,
		Type:      "assistant_message",
		Payload:   json.RawMessage(`{invalid json`),
		CreatedAt: 1700000009000,
	}

	// Should not panic
	msg := EventToStored(row)
	if msg.ID != "10" {
		t.Errorf("expected ID '10', got %q", msg.ID)
	}
}

func TestEventToStored_StringEncodedPayload(t *testing.T) {
	// Server stores payload as TEXT; Elysia re-serializes so it arrives
	// as a JSON string (double-encoded).
	inner := `{"content":"Hello from user","role":"user"}`
	doubleEncoded, _ := json.Marshal(inner) // produces `"{ ... }"`

	row := EventRow{
		ID:        11,
		Seq:       20,
		Type:      "user_message",
		Payload:   json.RawMessage(doubleEncoded),
		CreatedAt: 1700000010000,
	}

	msg := EventToStored(row)
	if msg.Text != "Hello from user" {
		t.Errorf("expected text from string-encoded payload, got %q", msg.Text)
	}
	if msg.Sender != SenderUser {
		t.Errorf("expected sender 'user', got %q", msg.Sender)
	}
}

func TestIsRenderable(t *testing.T) {
	tests := []struct {
		eventType string
		want      bool
	}{
		{"user_message", true},
		{"assistant_message", true},
		{"tool_execution", true},
		{"memory_recall", true},
		{"memory_retain", true},
		{"error", true},
		{"agent_start", false},
		{"agent_end", false},
		{"run_closed", false},
		{"unknown_event", false},
	}

	for _, tt := range tests {
		if got := IsRenderable(tt.eventType); got != tt.want {
			t.Errorf("IsRenderable(%q) = %v, want %v", tt.eventType, got, tt.want)
		}
	}
}

func TestIsAgentRunOpen(t *testing.T) {
	tests := []struct {
		name string
		rows []EventRow
		want bool
	}{
		{
			name: "no events",
			rows: nil,
			want: false,
		},
		{
			name: "started only",
			rows: []EventRow{{Type: "agent_start"}},
			want: true,
		},
		{
			name: "start then end",
			rows: []EventRow{{Type: "agent_start"}, {Type: "agent_end"}},
			want: false,
		},
		{
			name: "start, end, start",
			rows: []EventRow{
				{Type: "agent_start"}, {Type: "agent_end"}, {Type: "agent_start"},
			},
			want: true,
		},
		{
			name: "run_closed",
			rows: []EventRow{{Type: "agent_start"}, {Type: "run_closed"}},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAgentRunOpen(tt.rows); got != tt.want {
				t.Errorf("IsAgentRunOpen() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestComputeStatsFromEvents(t *testing.T) {
	events := []EventRow{
		{
			Type:    "user_message",
			Payload: mustJSON(map[string]interface{}{"content": "hi"}),
		},
		{
			Type: "assistant_message",
			Payload: mustJSON(map[string]interface{}{
				"streaming": false,
				"message": map[string]interface{}{
					"model":    "claude-sonnet-4-20250514",
					"provider": "anthropic",
					"usage": map[string]interface{}{
						"input":  100.0,
						"output": 50.0,
						"cost":   map[string]interface{}{"total": 0.0015},
					},
				},
			}),
		},
		{
			Type: "assistant_message",
			Payload: mustJSON(map[string]interface{}{
				"streaming": true, // skip in-flight
				"message":   map[string]interface{}{},
			}),
		},
	}

	stats := ComputeStatsFromEvents(events)

	if stats.MessageCount != 2 { // user + completed assistant
		t.Errorf("expected 2 messages, got %d", stats.MessageCount)
	}
	if stats.PromptTokens != 100 {
		t.Errorf("expected 100 prompt tokens, got %d", stats.PromptTokens)
	}
	if stats.CompletionTokens != 50 {
		t.Errorf("expected 50 completion tokens, got %d", stats.CompletionTokens)
	}
	if stats.Model == nil || *stats.Model != "claude-sonnet-4-20250514" {
		t.Errorf("expected model, got %v", stats.Model)
	}
}

func TestMergeStats(t *testing.T) {
	m := "model-a"
	prev := SessionStats{MessageCount: 5, PromptTokens: 100}
	delta := SessionStats{
		Model:            &m,
		MessageCount:     1,
		PromptTokens:     20,
		CompletionTokens: 10,
	}

	merged := MergeStats(prev, delta)
	if merged.MessageCount != 6 {
		t.Errorf("expected 6, got %d", merged.MessageCount)
	}
	if merged.PromptTokens != 120 {
		t.Errorf("expected 120, got %d", merged.PromptTokens)
	}
	if merged.Model == nil || *merged.Model != "model-a" {
		t.Errorf("expected model-a, got %v", merged.Model)
	}
}
