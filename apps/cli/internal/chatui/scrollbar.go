package chatui

import (
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

const scrollbarHideDelay = 1500 * time.Millisecond

// scrollbarHideMsg is sent after the hide delay to auto-hide the scrollbar.
type scrollbarHideMsg struct{ id int }

var scrollbarThumbStyle = lipgloss.NewStyle().Foreground(colorSubtle)

// renderScrollbar overlays a scrollbar thumb on the right edge of the viewport
// view string. If totalLines <= vpHeight (all content visible), returns vpView
// unchanged.
func renderScrollbar(vpView string, totalLines, vpHeight int, scrollPercent float64) string {
	if totalLines <= vpHeight || vpHeight <= 0 {
		return vpView
	}

	// Compute thumb geometry.
	thumbHeight := vpHeight * vpHeight / totalLines
	if thumbHeight < 1 {
		thumbHeight = 1
	}
	thumbTop := int(scrollPercent * float64(vpHeight-thumbHeight))
	if thumbTop < 0 {
		thumbTop = 0
	}
	if thumbTop+thumbHeight > vpHeight {
		thumbTop = vpHeight - thumbHeight
	}

	thumbChar := scrollbarThumbStyle.Render("▐")

	lines := strings.Split(vpView, "\n")
	for i := thumbTop; i < thumbTop+thumbHeight && i < len(lines); i++ {
		lines[i] = overlayRight(lines[i], thumbChar)
	}

	return strings.Join(lines, "\n")
}

// overlayRight replaces the rightmost display column of line with overlay.
// If the line is empty, it just appends the overlay.
func overlayRight(line, overlay string) string {
	w := ansi.StringWidth(line)
	if w == 0 {
		return overlay
	}
	// Truncate to w-1 visible columns, then append the overlay character.
	trimmed := ansi.Truncate(line, w-1, "")
	return trimmed + overlay
}
