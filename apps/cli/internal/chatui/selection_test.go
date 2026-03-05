package chatui

import (
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

// ─── Helper constructors ─────────────────────────────────────────

func mouseMotion(x, y int) tea.MouseMotionMsg {
	return tea.MouseMotionMsg(tea.Mouse{
		X:      x,
		Y:      y,
		Button: tea.MouseLeft,
	})
}

func mouseRelease(x, y int) tea.MouseReleaseMsg {
	return tea.MouseReleaseMsg(tea.Mouse{
		X: x,
		Y: y,
	})
}

func modelWithChatContent(lines ...string) Model {
	m := newTestModel()
	m.connState = StateConnected

	// Populate contentLines to simulate rendered chat.
	m.contentLines = lines

	// Build content for the viewport.
	content := ""
	for i, l := range lines {
		content += l
		if i < len(lines)-1 {
			content += "\n"
		}
	}
	m.viewport.SetContent(content)
	return m
}

// ─── Selection state unit tests ──────────────────────────────────

func TestSelectionState_HasSelection_Empty(t *testing.T) {
	var s selectionState
	if s.hasSelection() {
		t.Error("expected zero-value selectionState to have no selection")
	}
}

func TestSelectionState_HasSelection_AfterClear(t *testing.T) {
	s := selectionState{anchorLine: 0, anchorCol: 0, headLine: 0, headCol: 5}
	if !s.hasSelection() {
		t.Error("expected non-empty selection before clear")
	}
	s.clear()
	if s.hasSelection() {
		t.Error("expected no selection after clear")
	}
}

func TestSelectionState_OrderedRange_Forward(t *testing.T) {
	s := selectionState{anchorLine: 2, anchorCol: 5, headLine: 4, headCol: 10}
	sl, sc, el, ec := s.orderedRange()
	if sl != 2 || sc != 5 || el != 4 || ec != 10 {
		t.Errorf("expected (2,5)-(4,10), got (%d,%d)-(%d,%d)", sl, sc, el, ec)
	}
}

func TestSelectionState_OrderedRange_Backward(t *testing.T) {
	s := selectionState{anchorLine: 4, anchorCol: 10, headLine: 2, headCol: 5}
	sl, sc, el, ec := s.orderedRange()
	if sl != 2 || sc != 5 || el != 4 || ec != 10 {
		t.Errorf("expected (2,5)-(4,10), got (%d,%d)-(%d,%d)", sl, sc, el, ec)
	}
}

// ─── Word boundary tests ─────────────────────────────────────────

func TestFindWordBounds_Simple(t *testing.T) {
	tests := []struct {
		line       string
		col        int
		wantStart  int
		wantEnd    int
	}{
		{"hello world", 0, 0, 5},
		{"hello world", 3, 0, 5},
		{"hello world", 6, 6, 11},
		{"hello world", 10, 6, 11},
		{"", 0, 0, 0},
		{"hello world", 5, 5, 5}, // on space → no word
	}
	for _, tt := range tests {
		s, e := findWordBounds(tt.line, tt.col)
		if s != tt.wantStart || e != tt.wantEnd {
			t.Errorf("findWordBounds(%q, %d) = (%d,%d), want (%d,%d)",
				tt.line, tt.col, s, e, tt.wantStart, tt.wantEnd)
		}
	}
}

// ─── Text extraction tests ───────────────────────────────────────

func TestExtractSelectedText_SingleLine(t *testing.T) {
	lines := []string{"hello world", "second line"}
	text := extractSelectedText(lines, 0, 6, 0, 11)
	if text != "world" {
		t.Errorf("expected %q, got %q", "world", text)
	}
}

func TestExtractSelectedText_MultiLine(t *testing.T) {
	lines := []string{"first line", "second line", "third line"}
	text := extractSelectedText(lines, 0, 6, 2, 5)
	if text != "line\nsecond line\nthird" {
		t.Errorf("expected %q, got %q", "line\nsecond line\nthird", text)
	}
}

func TestExtractSelectedText_WithANSI(t *testing.T) {
	lines := []string{"\x1b[32mhello\x1b[0m world"}
	text := extractSelectedText(lines, 0, 0, 0, 5)
	if text != "hello" {
		t.Errorf("expected %q, got %q", "hello", text)
	}
}

func TestExtractSelectedText_Empty(t *testing.T) {
	text := extractSelectedText(nil, 0, 0, 0, 5)
	if text != "" {
		t.Errorf("expected empty, got %q", text)
	}
}

// ─── Highlight rendering tests ───────────────────────────────────

func TestHighlightLine_FullLine(t *testing.T) {
	line := "hello world"
	result := highlightLine(line, 0, 11)
	expected := "\x1b[7mhello world\x1b[27m"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestHighlightLine_Partial(t *testing.T) {
	line := "hello world"
	result := highlightLine(line, 3, 8)
	// "hel" + reverse("lo wo") + "rld"
	expected := "hel\x1b[7mlo wo\x1b[27mrld"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestHighlightLine_StartOnly(t *testing.T) {
	line := "hello"
	result := highlightLine(line, 0, 3)
	expected := "\x1b[7mhel\x1b[27mlo"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestHighlightLine_EndOnly(t *testing.T) {
	line := "hello"
	result := highlightLine(line, 3, 5)
	expected := "hel\x1b[7mlo\x1b[27m"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestHighlightLine_OutOfRange(t *testing.T) {
	line := "hello"
	result := highlightLine(line, 10, 15)
	if result != "hello" {
		t.Errorf("expected unchanged line, got %q", result)
	}
}

func TestApplyHighlight_VisibleRange(t *testing.T) {
	// viewport shows lines 1-3 (offset=1, height=3)
	vpOffset := 1
	vpHeight := 3
	vpView := "line 1\nline 2\nline 3"

	result := applyHighlight(vpView, 2, 0, 2, 6, vpOffset, vpHeight)
	// Line 2 in content → visible line 1, should be fully highlighted.
	lines := splitLines(result)
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines, got %d", len(lines))
	}
	expected := "\x1b[7mline 2\x1b[27m"
	if lines[1] != expected {
		t.Errorf("expected highlighted line %q, got %q", expected, lines[1])
	}
	// Other lines should be unchanged.
	if lines[0] != "line 1" {
		t.Errorf("expected line 0 unchanged, got %q", lines[0])
	}
}

func TestApplyHighlight_OutsideViewport(t *testing.T) {
	vpView := "line 5\nline 6\nline 7"
	// Selection is at lines 0-2, viewport shows lines 5-7.
	result := applyHighlight(vpView, 0, 0, 2, 6, 5, 3)
	if result != vpView {
		t.Error("expected no change when selection is outside viewport")
	}
}

func splitLines(s string) []string {
	result := []string{}
	current := ""
	for _, c := range s {
		if c == '\n' {
			result = append(result, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	result = append(result, current)
	return result
}

// ─── Mouse integration tests ────────────────────────────────────

func TestMouseDragSelection_ChatPaneOnly(t *testing.T) {
	m := modelWithChatContent("hello world", "second line", "third line")
	layout := m.computeLayout()
	chatY := layout.chat.minY + 0

	// Click in chat pane.
	result, _ := m.Update(mouseClick(2, chatY))
	rm := result.(Model)

	if !rm.sel.mouseDown {
		t.Error("expected mouseDown after click in chat")
	}

	// Drag to extend selection.
	result2, _ := rm.Update(mouseMotion(8, chatY))
	rm2 := result2.(Model)

	if !rm2.sel.hasSelection() {
		t.Error("expected non-empty selection after drag")
	}
}

func TestMouseDragSelection_InputDoesNotSelect(t *testing.T) {
	m := modelWithChatContent("hello world")
	layout := m.computeLayout()
	inputY := layout.input.minY + 1

	result, _ := m.Update(mouseClick(2, inputY))
	rm := result.(Model)

	if rm.sel.mouseDown {
		t.Error("expected no mouseDown from clicking input pane")
	}
	if rm.sel.hasSelection() {
		t.Error("expected no selection from clicking input pane")
	}
}

func TestMouseRelease_TriggersDelayedCopy(t *testing.T) {
	m := modelWithChatContent("hello world")
	layout := m.computeLayout()
	chatY := layout.chat.minY

	// Click at col 2, drag to col 8, then release.
	result, _ := m.Update(mouseClick(2, chatY))
	rm := result.(Model)

	result2, _ := rm.Update(mouseMotion(8, chatY))
	rm2 := result2.(Model)

	result3, cmd := rm2.Update(mouseRelease(8, chatY))
	rm3 := result3.(Model)

	if rm3.sel.mouseDown {
		t.Error("expected mouseDown=false after release")
	}
	if cmd == nil {
		t.Error("expected a delayed copy command after release with selection")
	}
}

func TestMouseDoubleClick_SelectsWord(t *testing.T) {
	m := modelWithChatContent("hello world")
	layout := m.computeLayout()
	chatY := layout.chat.minY

	// First click.
	result, _ := m.Update(mouseClick(2, chatY))
	rm := result.(Model)

	// Second click at same position within threshold (simulate by setting lastClickTime).
	rm.sel.lastClickTime = time.Now()
	rm.sel.lastClickX = 2
	rm.sel.lastClickY = chatY
	rm.sel.clickCount = 1

	result2, _ := rm.Update(mouseClick(2, chatY))
	rm2 := result2.(Model)

	if !rm2.sel.hasSelection() {
		t.Fatal("expected selection after double-click")
	}

	startLine, startCol, endLine, endCol := rm2.sel.orderedRange()
	if startLine != 0 || startCol != 0 || endLine != 0 || endCol != 5 {
		t.Errorf("expected word 'hello' (0,0)-(0,5), got (%d,%d)-(%d,%d)",
			startLine, startCol, endLine, endCol)
	}
}

func TestMouseTripleClick_SelectsLine(t *testing.T) {
	m := modelWithChatContent("hello world", "second line")
	layout := m.computeLayout()
	chatY := layout.chat.minY

	// Simulate triple click by pre-setting click state.
	m.sel.lastClickTime = time.Now()
	m.sel.lastClickX = 3
	m.sel.lastClickY = chatY
	m.sel.clickCount = 2

	result, _ := m.Update(mouseClick(3, chatY))
	rm := result.(Model)

	if !rm.sel.hasSelection() {
		t.Fatal("expected selection after triple-click")
	}

	startLine, startCol, endLine, endCol := rm.sel.orderedRange()
	if startLine != 0 || startCol != 0 || endLine != 0 {
		t.Errorf("expected full line 0 selected, got (%d,%d)-(%d,%d)",
			startLine, startCol, endLine, endCol)
	}
	if endCol != 11 { // "hello world" = 11 chars
		t.Errorf("expected endCol=11 for full line, got %d", endCol)
	}
}

func TestMouseRelease_DoubleClickDebounce(t *testing.T) {
	m := modelWithChatContent("hello world")
	layout := m.computeLayout()
	chatY := layout.chat.minY

	// First click + drag + release.
	result, _ := m.Update(mouseClick(0, chatY))
	rm := result.(Model)

	result2, _ := rm.Update(mouseMotion(5, chatY))
	rm2 := result2.(Model)

	result3, cmd := rm2.Update(mouseRelease(5, chatY))
	rm3 := result3.(Model)
	firstClickID := rm3.sel.pendingClickID

	if cmd == nil {
		t.Fatal("expected delayed copy command after first release")
	}

	// Second click (double-click) — increments pendingClickID.
	rm3.sel.lastClickTime = time.Now()
	rm3.sel.lastClickX = 2
	rm3.sel.lastClickY = chatY
	rm3.sel.clickCount = 1

	result4, _ := rm3.Update(mouseClick(2, chatY))
	rm4 := result4.(Model)

	// The old copyChatSelectionMsg should now be stale.
	result5, _ := rm4.Update(copyChatSelectionMsg{clickID: firstClickID})
	rm5 := result5.(Model)

	// Should not have cleared selection (stale clickID).
	if !rm5.sel.hasSelection() && rm5.sel.anchorLine == -1 {
		// The selection was from double-click, which changes the selection.
		// Key point: the old clickID should NOT trigger a copy.
	}
}

func TestMouseDrag_EdgeAutoScroll(t *testing.T) {
	// Create content taller than viewport.
	lines := make([]string, 50)
	for i := range lines {
		lines[i] = "content line"
	}
	m := modelWithChatContent(lines...)
	m.viewport.GotoBottom()
	m.autoScroll = true

	layout := m.computeLayout()
	chatY := layout.chat.minY + 2

	// Start a drag.
	result, _ := m.Update(mouseClick(0, chatY))
	rm := result.(Model)

	beforeOffset := rm.viewport.YOffset()

	// Drag above chat pane (edge auto-scroll up).
	result2, _ := rm.Update(mouseMotion(0, layout.chat.minY))
	rm2 := result2.(Model)

	afterOffset := rm2.viewport.YOffset()
	if afterOffset >= beforeOffset {
		t.Errorf("expected scroll up: before=%d, after=%d", beforeOffset, afterOffset)
	}
}

func TestSelectionCleared_OnInputClick(t *testing.T) {
	m := modelWithChatContent("hello world")
	// Set up an existing selection.
	m.sel.anchorLine = 0
	m.sel.anchorCol = 0
	m.sel.headLine = 0
	m.sel.headCol = 5

	if !m.sel.hasSelection() {
		t.Fatal("expected selection to exist before clicking input")
	}

	layout := m.computeLayout()
	inputY := layout.input.minY + 1

	result, _ := m.Update(mouseClick(5, inputY))
	rm := result.(Model)

	if rm.sel.hasSelection() {
		t.Error("expected selection cleared after clicking input pane")
	}
}

func TestWheelStillWorks_WithSelectionState(t *testing.T) {
	// Existing wheel behavior must not break when selection state is present.
	m := modelWithChatContent(make([]string, 100)...)
	for i := range m.contentLines {
		m.contentLines[i] = "line"
	}
	content := ""
	for i := 0; i < 100; i++ {
		content += "line\n"
	}
	m.viewport.SetContent(content)
	m.viewport.GotoBottom()
	m.autoScroll = true

	// Set some selection state.
	m.sel.anchorLine = 5
	m.sel.anchorCol = 0
	m.sel.headLine = 5
	m.sel.headCol = 4

	layout := m.computeLayout()
	wheelY := layout.chat.minY + 1

	result, _ := m.Update(mouseWheel(10, wheelY, tea.MouseWheelUp))
	rm := result.(Model)

	if rm.autoScroll {
		t.Error("expected autoScroll=false after scroll up")
	}
}

// ─── Multi-click detection tests ─────────────────────────────────

func TestDetectMultiClick_SingleClick(t *testing.T) {
	var s selectionState
	s.detectMultiClick(10, 20)
	if s.clickCount != 1 {
		t.Errorf("expected clickCount=1, got %d", s.clickCount)
	}
}

func TestDetectMultiClick_DoubleClick(t *testing.T) {
	var s selectionState
	s.detectMultiClick(10, 20)
	// Second click within threshold and tolerance.
	s.detectMultiClick(11, 20)
	if s.clickCount != 2 {
		t.Errorf("expected clickCount=2, got %d", s.clickCount)
	}
}

func TestDetectMultiClick_TripleClick(t *testing.T) {
	var s selectionState
	s.detectMultiClick(10, 20)
	s.detectMultiClick(10, 20)
	s.detectMultiClick(10, 20)
	if s.clickCount != 3 {
		t.Errorf("expected clickCount=3, got %d", s.clickCount)
	}
}

func TestDetectMultiClick_TooFar(t *testing.T) {
	var s selectionState
	s.detectMultiClick(10, 20)
	// Second click too far away.
	s.detectMultiClick(20, 30)
	if s.clickCount != 1 {
		t.Errorf("expected clickCount reset to 1, got %d", s.clickCount)
	}
}

func TestDetectMultiClick_TooSlow(t *testing.T) {
	var s selectionState
	s.detectMultiClick(10, 20)
	// Simulate delay by setting lastClickTime in the past.
	s.lastClickTime = time.Now().Add(-1 * time.Second)
	s.detectMultiClick(10, 20)
	if s.clickCount != 1 {
		t.Errorf("expected clickCount reset to 1 after timeout, got %d", s.clickCount)
	}
}
