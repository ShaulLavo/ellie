package chatui

// PromptHistory provides boundary-aware up/down navigation through
// previous user messages, ported from Crush's history.go.
type PromptHistory struct {
	messages []string // oldest-last order (index 0 = most recent)
	index    int      // -1 = at draft, 0+ = in history
	draft    string   // saved current input before entering history
}

// NewPromptHistory creates an empty history.
func NewPromptHistory() *PromptHistory {
	return &PromptHistory{index: -1}
}

// Add appends a sent message to history (prepended to messages slice for
// index-0 = most recent).
func (h *PromptHistory) Add(text string) {
	if text == "" {
		return
	}
	// Prepend for most-recent-first order
	h.messages = append([]string{text}, h.messages...)
	h.Reset()
}

// Prev navigates to an older history entry.
// Returns the text and true if navigation succeeded.
func (h *PromptHistory) Prev(currentText string) (string, bool) {
	if len(h.messages) == 0 {
		return "", false
	}
	// Save draft when first entering history
	if h.index == -1 {
		h.draft = currentText
	}
	nextIndex := h.index + 1
	if nextIndex >= len(h.messages) {
		return "", false
	}
	h.index = nextIndex
	return h.messages[nextIndex], true
}

// Next navigates to a newer history entry or back to draft.
// Returns the text and true if navigation succeeded.
func (h *PromptHistory) Next() (string, bool) {
	if h.index < 0 {
		return "", false
	}
	nextIndex := h.index - 1
	if nextIndex < 0 {
		h.index = -1
		return h.draft, true
	}
	h.index = nextIndex
	return h.messages[nextIndex], true
}

// EscapeToDraft returns to draft if currently browsing history.
// Returns the draft text and true if we were in history.
func (h *PromptHistory) EscapeToDraft() (string, bool) {
	if h.index < 0 {
		return "", false
	}
	h.index = -1
	return h.draft, true
}

// Reset resets the navigation index but keeps messages.
func (h *PromptHistory) Reset() {
	h.index = -1
	h.draft = ""
}

// UpdateDraft updates the draft when text is modified while not in history.
func (h *PromptHistory) UpdateDraft(text string) {
	if h.index == -1 {
		h.draft = text
	}
}

// InHistory returns true if currently navigating history.
func (h *PromptHistory) InHistory() bool {
	return h.index >= 0
}
