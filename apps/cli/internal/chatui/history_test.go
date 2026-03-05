package chatui

import "testing"

func TestPromptHistory_PrevNext(t *testing.T) {
	h := NewPromptHistory()
	h.Add("first")
	h.Add("second")
	h.Add("third")

	// Navigate backwards: third → second → first
	text, ok := h.Prev("current draft")
	if !ok || text != "third" {
		t.Errorf("expected 'third', got %q (ok=%v)", text, ok)
	}

	text, ok = h.Prev("")
	if !ok || text != "second" {
		t.Errorf("expected 'second', got %q (ok=%v)", text, ok)
	}

	text, ok = h.Prev("")
	if !ok || text != "first" {
		t.Errorf("expected 'first', got %q (ok=%v)", text, ok)
	}

	// Past end
	_, ok = h.Prev("")
	if ok {
		t.Error("expected false past end of history")
	}

	// Navigate forward: first → second → third → draft
	text, ok = h.Next()
	if !ok || text != "second" {
		t.Errorf("expected 'second', got %q (ok=%v)", text, ok)
	}

	text, ok = h.Next()
	if !ok || text != "third" {
		t.Errorf("expected 'third', got %q (ok=%v)", text, ok)
	}

	text, ok = h.Next()
	if !ok || text != "current draft" {
		t.Errorf("expected 'current draft', got %q (ok=%v)", text, ok)
	}

	// Past beginning
	_, ok = h.Next()
	if ok {
		t.Error("expected false when already at draft")
	}
}

func TestPromptHistory_EscapeToDraft(t *testing.T) {
	h := NewPromptHistory()
	h.Add("msg1")

	// Not in history
	_, ok := h.EscapeToDraft()
	if ok {
		t.Error("expected false when not in history")
	}

	// Enter history
	h.Prev("my draft")

	// Escape back
	text, ok := h.EscapeToDraft()
	if !ok || text != "my draft" {
		t.Errorf("expected 'my draft', got %q (ok=%v)", text, ok)
	}

	if h.InHistory() {
		t.Error("should not be in history after escape")
	}
}

func TestPromptHistory_EmptyAdd(t *testing.T) {
	h := NewPromptHistory()
	h.Add("")

	_, ok := h.Prev("")
	if ok {
		t.Error("empty string should not be added to history")
	}
}

func TestPromptHistory_DraftPreserved(t *testing.T) {
	h := NewPromptHistory()
	h.Add("old message")

	// Go into history with a draft
	h.Prev("work in progress")

	// Come back
	text, _ := h.Next()
	if text != "work in progress" {
		t.Errorf("draft not preserved, got %q", text)
	}
}

func TestPromptHistory_Reset(t *testing.T) {
	h := NewPromptHistory()
	h.Add("msg")
	h.Prev("draft")

	h.Reset()

	if h.InHistory() {
		t.Error("should not be in history after reset")
	}
}
