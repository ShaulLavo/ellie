package chatui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// applyHighlight applies reverse-video highlighting to the viewport view
// string for the given selection range.
//
// Selection coordinates (startLine..endLine, startCol..endCol) are in
// content-line space. vpOffset is viewport.YOffset() used to convert to
// viewport-visible line indices.
func applyHighlight(vpView string, startLine, startCol, endLine, endCol, vpOffset, vpHeight int) string {
	// Convert content-line coords to viewport-visible line indices.
	visStartLine := startLine - vpOffset
	visEndLine := endLine - vpOffset

	// Selection completely outside visible range.
	if visEndLine < 0 || visStartLine >= vpHeight {
		return vpView
	}

	lines := strings.Split(vpView, "\n")

	for i := range lines {
		if i < visStartLine || i > visEndLine {
			continue
		}
		if i >= len(lines) {
			break
		}

		lineWidth := ansi.StringWidth(lines[i])

		sc := 0
		if i == visStartLine {
			sc = startCol
		}
		ec := lineWidth
		if i == visEndLine {
			ec = endCol
		}

		if sc >= lineWidth || ec <= 0 || sc >= ec {
			continue
		}

		lines[i] = highlightLine(lines[i], sc, ec)
	}

	return strings.Join(lines, "\n")
}

// highlightLine applies reverse video to the portion of line between startCol
// and endCol (display-width columns). It preserves existing ANSI styling by
// injecting reverse-video escape sequences at the right positions.
func highlightLine(line string, startCol, endCol int) string {
	lineWidth := ansi.StringWidth(line)
	if startCol >= lineWidth {
		return line
	}
	if endCol > lineWidth {
		endCol = lineWidth
	}
	if startCol < 0 {
		startCol = 0
	}

	// Split the line at the selection boundaries using ANSI-aware truncation.
	prefix := ansi.Truncate(line, startCol, "")
	rest := line[len(prefix):]

	selected := ansi.Truncate(rest, endCol-startCol, "")
	suffix := rest[len(selected):]

	// Wrap the selected portion with reverse video escape sequences.
	// \x1b[7m enables reverse; \x1b[27m disables only reverse, preserving
	// other active attributes (colors, bold, etc.).
	return prefix + "\x1b[7m" + selected + "\x1b[27m" + suffix
}
