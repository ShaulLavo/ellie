package chatui

import (
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// Multi-click detection constants.
const (
	doubleClickThreshold = 400 * time.Millisecond
	clickTolerance       = 2
)

// copyChatSelectionMsg is sent after the debounce delay to trigger clipboard copy.
type copyChatSelectionMsg struct {
	clickID int
}

// selectionState tracks mouse text selection in the chat pane.
type selectionState struct {
	// Whether the mouse button is currently held down.
	mouseDown bool

	// Anchor (initial press) and head (current drag) in content-line coordinates.
	anchorLine, anchorCol int
	headLine, headCol     int

	// Multi-click detection.
	lastClickTime time.Time
	lastClickX    int
	lastClickY    int
	clickCount    int

	// Incremented on each click to invalidate stale delayed-copy ticks.
	pendingClickID int
}

// hasSelection returns whether there is a non-empty selection.
func (s *selectionState) hasSelection() bool {
	return s.anchorLine >= 0 && s.headLine >= 0 &&
		(s.anchorLine != s.headLine || s.anchorCol != s.headCol)
}

// orderedRange returns the selection endpoints in top-to-bottom order.
func (s *selectionState) orderedRange() (startLine, startCol, endLine, endCol int) {
	if s.anchorLine < s.headLine ||
		(s.anchorLine == s.headLine && s.anchorCol <= s.headCol) {
		return s.anchorLine, s.anchorCol, s.headLine, s.headCol
	}
	return s.headLine, s.headCol, s.anchorLine, s.anchorCol
}

// clear resets all selection state.
func (s *selectionState) clear() {
	s.mouseDown = false
	s.anchorLine = -1
	s.anchorCol = -1
	s.headLine = -1
	s.headCol = -1
	s.pendingClickID++
}

// detectMultiClick updates click counting based on timing and position proximity.
func (s *selectionState) detectMultiClick(screenX, screenY int) {
	now := time.Now()
	if now.Sub(s.lastClickTime) <= doubleClickThreshold &&
		intAbs(screenX-s.lastClickX) <= clickTolerance &&
		intAbs(screenY-s.lastClickY) <= clickTolerance {
		s.clickCount++
	} else {
		s.clickCount = 1
	}
	s.lastClickTime = now
	s.lastClickX = screenX
	s.lastClickY = screenY
}

// selectWord sets anchor/head to word boundaries at the given content position.
func (s *selectionState) selectWord(contentLines []string, line, col int) {
	if line < 0 || line >= len(contentLines) {
		return
	}
	plain := ansi.Strip(contentLines[line])
	start, end := findWordBounds(plain, col)
	if start == end {
		// No word found; set a point selection.
		s.mouseDown = true
		s.anchorLine = line
		s.anchorCol = col
		s.headLine = line
		s.headCol = col
		return
	}
	s.mouseDown = true
	s.anchorLine = line
	s.anchorCol = start
	s.headLine = line
	s.headCol = end
}

// selectLine sets anchor/head to cover the entire line.
func (s *selectionState) selectLine(contentLines []string, line int) {
	if line < 0 || line >= len(contentLines) {
		return
	}
	plain := ansi.Strip(contentLines[line])
	s.mouseDown = true
	s.anchorLine = line
	s.anchorCol = 0
	s.headLine = line
	s.headCol = ansi.StringWidth(plain)
}

// findWordBounds returns [start, end) display-column indices of the word at col.
// Uses whitespace-based word boundaries.
func findWordBounds(plain string, col int) (int, int) {
	runes := []rune(plain)
	if len(runes) == 0 || col < 0 {
		return 0, 0
	}
	if col >= len(runes) {
		col = len(runes) - 1
	}
	if col < 0 {
		return 0, 0
	}
	if isWordSep(runes[col]) {
		return col, col
	}
	start := col
	for start > 0 && !isWordSep(runes[start-1]) {
		start--
	}
	end := col
	for end < len(runes) && !isWordSep(runes[end]) {
		end++
	}
	return start, end
}

func isWordSep(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r'
}

func intAbs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// extractSelectedText returns the plain text within the selection range.
func extractSelectedText(contentLines []string, startLine, startCol, endLine, endCol int) string {
	if startLine < 0 || endLine < 0 || len(contentLines) == 0 {
		return ""
	}
	if startLine >= len(contentLines) {
		startLine = len(contentLines) - 1
	}
	if endLine >= len(contentLines) {
		endLine = len(contentLines) - 1
	}

	var sb strings.Builder
	for line := startLine; line <= endLine; line++ {
		plain := ansi.Strip(contentLines[line])
		runes := []rune(plain)

		colStart := 0
		if line == startLine {
			colStart = startCol
		}
		colEnd := len(runes)
		if line == endLine {
			colEnd = endCol
		}

		// Clamp to valid range.
		colStart = max(colStart, 0)
		colEnd = max(colEnd, 0)
		if colStart > len(runes) {
			colStart = len(runes)
		}
		if colEnd > len(runes) {
			colEnd = len(runes)
		}
		if colEnd > colStart {
			sb.WriteString(string(runes[colStart:colEnd]))
		}
		if line < endLine {
			sb.WriteString("\n")
		}
	}
	return sb.String()
}
