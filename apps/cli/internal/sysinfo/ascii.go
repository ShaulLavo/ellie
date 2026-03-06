package sysinfo

import (
	"image/color"
	"runtime"
	"strings"

	"charm.land/lipgloss/v2"
)

// Standard ANSI colors matching macchina's ratatui Color enum.
var (
	ansiGreen   = lipgloss.Color("#34C759")
	ansiYellow  = lipgloss.Color("#FFCC00")
	ansiRed     = lipgloss.Color("#FF3B30")
	ansiMagenta = lipgloss.Color("#AF52DE")
	ansiBlue    = lipgloss.Color("#007AFF")
	ansiWhite   = lipgloss.Color("#FFFFFF")
	ansiBlack   = lipgloss.Color("#666666") // visible on dark terminals
)

// Span is a piece of text with a single color.
type Span struct {
	Text  string
	Color color.Color
}

// LogoLine is a line of colored spans.
type LogoLine []Span

// Logo holds the complete ASCII art definition.
type Logo struct {
	Lines []LogoLine
}

// Render produces the styled string for the full logo.
func (l Logo) Render() string {
	var rendered []string
	for _, line := range l.Lines {
		var parts []string
		for _, span := range line {
			style := lipgloss.NewStyle().Foreground(span.Color)
			parts = append(parts, style.Render(span.Text))
		}
		rendered = append(rendered, strings.Join(parts, ""))
	}
	return strings.Join(rendered, "\n")
}

// Width returns the max visual width of the logo (uncolored).
func (l Logo) Width() int {
	max := 0
	for _, line := range l.Lines {
		w := 0
		for _, span := range line {
			w += len(span.Text)
		}
		if w > max {
			max = w
		}
	}
	return max
}

// s is a shorthand for creating a single-color span.
func s(text string, c color.Color) Span {
	return Span{Text: text, Color: c}
}

// line creates a LogoLine from spans.
func line(spans ...Span) LogoLine {
	return spans
}

// solidLine creates a line with a single color.
func solidLine(text string, c color.Color) LogoLine {
	return LogoLine{s(text, c)}
}

// SelectLogo returns the appropriate logo for the current OS.
func SelectLogo() Logo {
	switch runtime.GOOS {
	case "darwin":
		return LogoMacOSBig()
	case "linux":
		return LogoLinuxBig()
	case "windows":
		return LogoWindowsBig()
	case "android":
		return LogoAndroidBig()
	case "freebsd":
		return LogoFreeBSD()
	case "netbsd":
		return LogoNetBSDBig()
	default:
		return LogoLinuxBig()
	}
}
