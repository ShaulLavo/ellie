package chatui

import (
	"strings"
	"testing"
)

func TestMessagesToTranscript(t *testing.T) {
	messages := []StoredMessage{
		{
			ID:        "1",
			Timestamp: "2024-01-15T10:30:00Z",
			Text:      "Hello",
			Parts:     []ContentPart{{Type: PartText, Text: "Hello"}},
			Sender:    SenderUser,
		},
		{
			ID:        "2",
			Timestamp: "2024-01-15T10:30:05Z",
			Text:      "Hi there!",
			Parts:     []ContentPart{{Type: PartText, Text: "Hi there!"}},
			Sender:    SenderAgent,
			Thinking:  "Let me respond warmly",
		},
	}

	transcript := MessagesToTranscript(messages)

	if transcript.EntryCount != 2 {
		t.Errorf("expected 2 entries, got %d", transcript.EntryCount)
	}
	if transcript.Entries[0].Role != "user" {
		t.Errorf("expected role 'user', got %q", transcript.Entries[0].Role)
	}
	if transcript.Entries[1].Role != "assistant" {
		t.Errorf("expected role 'assistant', got %q", transcript.Entries[1].Role)
	}
	// Second entry should include thinking
	if !strings.Contains(transcript.Entries[1].Content, "<thinking>") {
		t.Error("expected thinking block in assistant entry")
	}
}

func TestRenderTranscript(t *testing.T) {
	transcript := Transcript{
		GeneratedAt: "2024-01-15T10:30:10Z",
		EntryCount:  2,
		Entries: []TranscriptEntry{
			{
				ID:        "1",
				Timestamp: "2024-01-15T10:30:00Z",
				Role:      "user",
				Type:      "text",
				Content:   "Hello",
			},
			{
				ID:        "2",
				Timestamp: "2024-01-15T10:30:05Z",
				Role:      "assistant",
				Type:      "text",
				Content:   "Hi there!",
			},
		},
	}

	text := RenderTranscript(transcript)

	if !strings.Contains(text, "Transcript - 2 entries") {
		t.Error("expected header with entry count")
	}
	if !strings.Contains(text, "User (text)") {
		t.Error("expected 'User (text)' label")
	}
	if !strings.Contains(text, "Assistant (text)") {
		t.Error("expected 'Assistant (text)' label")
	}
	if !strings.Contains(text, "End of transcript") {
		t.Error("expected 'End of transcript' footer")
	}
	if !strings.Contains(text, "Hello") {
		t.Error("expected user message content")
	}
	if !strings.Contains(text, "Hi there!") {
		t.Error("expected assistant message content")
	}
}

func TestFormatPart_ToolCall(t *testing.T) {
	part := ContentPart{
		Type: PartToolCall,
		Name: "read_file",
		Args: map[string]interface{}{"path": "/foo/bar.go"},
	}

	result := formatPart(part)
	if !strings.Contains(result, "[Tool Call: read_file]") {
		t.Errorf("expected tool call header, got %q", result)
	}
	if !strings.Contains(result, "path: /foo/bar.go") {
		t.Errorf("expected args, got %q", result)
	}
}

func TestFormatPart_ToolResult(t *testing.T) {
	part := ContentPart{
		Type:     PartToolResult,
		ToolName: "read_file",
		Result:   "file contents",
	}

	result := formatPart(part)
	if !strings.Contains(result, "[Tool Result: read_file]") {
		t.Errorf("expected tool result header, got %q", result)
	}
}

func TestFormatPart_Memory(t *testing.T) {
	part := ContentPart{
		Type: PartMemory,
		Memories: []MemoryItem{
			{Text: "User prefers Go"},
			{Text: "Project uses Bubble Tea"},
		},
	}

	result := formatPart(part)
	if !strings.Contains(result, "[Memory Recall]") {
		t.Errorf("expected memory header, got %q", result)
	}
	if !strings.Contains(result, "User prefers Go") {
		t.Errorf("expected memory fact, got %q", result)
	}
}

func TestFormatPart_MemoryRetain(t *testing.T) {
	part := ContentPart{
		Type:        PartMemoryRetain,
		FactsStored: 2,
		Facts:       []string{"Fact 1", "Fact 2"},
	}

	result := formatPart(part)
	if !strings.Contains(result, "[Memory Retain - 2 facts]") {
		t.Errorf("expected retain header, got %q", result)
	}
}

func TestResolvePartType(t *testing.T) {
	tests := []struct {
		parts []ContentPart
		want  string
	}{
		{nil, "text"},
		{[]ContentPart{{Type: PartText}}, "text"},
		{[]ContentPart{{Type: PartToolCall}}, "tool-call"},
		{[]ContentPart{{Type: PartText}, {Type: PartToolCall}}, "mixed"},
	}

	for _, tt := range tests {
		got := resolvePartType(tt.parts)
		if got != tt.want {
			t.Errorf("resolvePartType() = %q, want %q", got, tt.want)
		}
	}
}

func TestResolveRoleFromSender(t *testing.T) {
	tests := []struct {
		sender MessageSender
		want   string
	}{
		{SenderUser, "user"},
		{SenderHuman, "user"},
		{SenderAgent, "assistant"},
		{SenderMemory, "memory"},
		{SenderSystem, "system"},
		{"", "user"},
	}

	for _, tt := range tests {
		got := resolveRoleFromSender(tt.sender)
		if got != tt.want {
			t.Errorf("resolveRoleFromSender(%q) = %q, want %q", tt.sender, got, tt.want)
		}
	}
}
