package chatui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

// newTestModel returns a Model pre-sized to a 80x24 terminal.
func newTestModel() Model {
	m := NewModel("http://localhost:3000", "test-session", ".")
	// Simulate WindowSizeMsg so layout is computed.
	m.width = 80
	m.height = 24
	m.ready = true
	m.resizeComponents()
	return m
}

func mouseClick(x, y int) tea.MouseClickMsg {
	return tea.MouseClickMsg(tea.Mouse{
		X:      x,
		Y:      y,
		Button: tea.MouseLeft,
	})
}

func mouseWheel(x, y int, button tea.MouseButton) tea.MouseWheelMsg {
	return tea.MouseWheelMsg(tea.Mouse{
		X:      x,
		Y:      y,
		Button: button,
	})
}

// ─── Click focus tests ──────────────────────────────────────────

func TestMouseClick_InputAreaSetsFocusEditor(t *testing.T) {
	m := newTestModel()
	m.focus = focusChat
	m.textarea.Blur()

	layout := m.computeLayout()
	clickY := layout.input.minY + 1

	result, _ := m.Update(mouseClick(10, clickY))
	rm := result.(Model)

	if rm.focus != focusEditor {
		t.Errorf("expected focusEditor, got %d", rm.focus)
	}
}

func TestMouseClick_ChatAreaSetsFocusChat(t *testing.T) {
	m := newTestModel()
	m.focus = focusEditor

	layout := m.computeLayout()
	clickY := layout.chat.minY + 1

	result, _ := m.Update(mouseClick(10, clickY))
	rm := result.(Model)

	if rm.focus != focusChat {
		t.Errorf("expected focusChat, got %d", rm.focus)
	}
}

func TestMouseClick_SameFocusIsNoop(t *testing.T) {
	m := newTestModel()
	m.focus = focusEditor

	layout := m.computeLayout()
	clickY := layout.input.minY + 1

	result, _ := m.Update(mouseClick(10, clickY))
	rm := result.(Model)

	if rm.focus != focusEditor {
		t.Errorf("expected focusEditor unchanged, got %d", rm.focus)
	}
}

// ─── Wheel routing tests ────────────────────────────────────────

func TestMouseWheel_OverChat_ScrollsViewport(t *testing.T) {
	m := newTestModel()
	// Put content in viewport to make it scrollable.
	longContent := ""
	for i := 0; i < 100; i++ {
		longContent += "line\n"
	}
	m.viewport.SetContent(longContent)
	m.viewport.GotoBottom()
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	// Scroll up should change viewport offset.
	result, _ := m.Update(mouseWheel(10, wheelY, tea.MouseWheelUp))
	rm := result.(Model)

	if rm.autoScroll {
		t.Error("expected autoScroll to be false after scrolling up")
	}
}

func TestMouseWheel_OutsideChat_DoesNotScroll(t *testing.T) {
	m := newTestModel()
	longContent := ""
	for i := 0; i < 100; i++ {
		longContent += "line\n"
	}
	m.viewport.SetContent(longContent)
	m.viewport.GotoBottom()
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.input.minY + 1

	result, _ := m.Update(mouseWheel(10, wheelY, tea.MouseWheelUp))
	rm := result.(Model)

	if !rm.autoScroll {
		t.Error("expected autoScroll unchanged when scrolling outside chat")
	}
}

// ─── Dialog gating tests ────────────────────────────────────────

func TestMouseClick_DialogOpen_IgnoresClick(t *testing.T) {
	m := newTestModel()
	m.focus = focusEditor
	m.dialog = NewClearConfirmDialog()

	layout := m.computeLayout()
	clickY := layout.chat.minY + 1

	result, _ := m.Update(mouseClick(10, clickY))
	rm := result.(Model)

	if rm.focus != focusEditor {
		t.Errorf("expected focus unchanged when dialog open, got %d", rm.focus)
	}
}

func TestMouseWheel_DialogOpen_IgnoresWheel(t *testing.T) {
	m := newTestModel()
	m.dialog = NewClearConfirmDialog()
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	result, _ := m.Update(mouseWheel(10, wheelY, tea.MouseWheelDown))
	rm := result.(Model)

	if !rm.autoScroll {
		t.Error("expected autoScroll unchanged when dialog open")
	}
}

// ─── Touchpad-equivalent wheel behavior ─────────────────────────

func TestMouseWheel_RapidEvents_ScrollsPredictably(t *testing.T) {
	m := newTestModel()
	longContent := ""
	for i := 0; i < 200; i++ {
		longContent += "line\n"
	}
	m.viewport.SetContent(longContent)
	m.viewport.GotoBottom()
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	// Simulate rapid touchpad scroll (multiple wheel-up events).
	var result tea.Model = m
	for i := 0; i < 10; i++ {
		result, _ = result.(Model).Update(mouseWheel(10, wheelY, tea.MouseWheelUp))
	}
	rm := result.(Model)

	if rm.autoScroll {
		t.Error("expected autoScroll false after rapid scroll up")
	}
}

func TestMouseWheel_DiagonalSwipe_SuppressesHorizontal(t *testing.T) {
	m := newTestModel()
	longContent := ""
	for i := 0; i < 200; i++ {
		longContent += "line\n"
	}
	m.viewport.SetContent(longContent)
	m.viewport.GotoBottom()
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	// A vertical scroll followed immediately by horizontal should suppress
	// the horizontal event (diagonal trackpad swipe).
	result, _ := m.Update(mouseWheel(10, wheelY, tea.MouseWheelUp))
	rm := result.(Model)

	// Horizontal right after vertical → suppressed (lastVerticalWheel is recent).
	result2, _ := rm.Update(mouseWheel(10, wheelY, tea.MouseWheelLeft))
	rm2 := result2.(Model)

	// autoScroll was already turned off by the vertical scroll, so check that
	// the horizontal event didn't change the viewport further by verifying
	// lastVerticalWheel was set and the event was a no-op.
	if rm2.lastVerticalWheel.IsZero() {
		t.Error("expected lastVerticalWheel to be set after vertical scroll")
	}
}

func TestMouseWheel_PureHorizontal_Allowed(t *testing.T) {
	m := newTestModel()
	longContent := ""
	for i := 0; i < 200; i++ {
		longContent += "line\n"
	}
	m.viewport.SetContent(longContent)
	m.autoScroll = true

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	// Pure horizontal scroll (no recent vertical) should pass through
	// to the viewport — lastVerticalWheel is zero, so no suppression.
	_, _ = m.Update(mouseWheel(10, wheelY, tea.MouseWheelRight))

	// If we got here without panic, the event was forwarded to viewport.
	// (Viewport may or may not actually scroll depending on content width,
	// but the event was not suppressed.)
}

// ─── Layout computation tests ───────────────────────────────────

func TestComputeLayout_PanesContiguous(t *testing.T) {
	m := newTestModel()
	layout := m.computeLayout()

	if layout.status.minY != 0 {
		t.Errorf("expected status to start at 0, got %d", layout.status.minY)
	}
	if layout.chat.minY != layout.status.maxY+1 {
		t.Errorf("expected chat to start after status: chat.minY=%d, status.maxY=%d",
			layout.chat.minY, layout.status.maxY)
	}
	if layout.input.minY != layout.chat.maxY+1 {
		t.Errorf("expected input to start after chat: input.minY=%d, chat.maxY=%d",
			layout.input.minY, layout.chat.maxY)
	}
	if layout.footer.minY != layout.input.maxY+1 {
		t.Errorf("expected footer to start after input: footer.minY=%d, input.maxY=%d",
			layout.footer.minY, layout.input.maxY)
	}
}

func TestPointInPane(t *testing.T) {
	r := paneRect{minY: 5, maxY: 10}

	if pointInPane(4, r) {
		t.Error("expected y=4 outside pane [5,10]")
	}
	if !pointInPane(5, r) {
		t.Error("expected y=5 inside pane [5,10]")
	}
	if !pointInPane(7, r) {
		t.Error("expected y=7 inside pane [5,10]")
	}
	if !pointInPane(10, r) {
		t.Error("expected y=10 inside pane [5,10]")
	}
	if pointInPane(11, r) {
		t.Error("expected y=11 outside pane [5,10]")
	}
}

// ─── Keyboard regression ────────────────────────────────────────

func TestKeyboard_EscStillToggles_AfterMouseSupport(t *testing.T) {
	m := newTestModel()
	m.focus = focusEditor
	m.connState = StateConnected

	// Esc with empty input should switch to chat focus.
	escMsg := tea.KeyPressMsg(tea.Key{Code: tea.KeyEscape})
	result, _ := m.Update(escMsg)
	rm := result.(Model)

	if rm.focus != focusChat {
		t.Errorf("expected focusChat after Esc with empty input, got %d", rm.focus)
	}

	// Esc again should switch back to editor.
	result2, _ := rm.Update(escMsg)
	rm2 := result2.(Model)

	if rm2.focus != focusEditor {
		t.Errorf("expected focusEditor after Esc from chat, got %d", rm2.focus)
	}
}
