package chatui

import (
	"image/color"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/exp/charmtone"
)

// ThemeMode selects between dark and light color schemes.
type ThemeMode int

const (
	ThemeDark ThemeMode = iota
	ThemeLight
)

// CurrentTheme is the active theme mode.
var CurrentTheme ThemeMode

// Ellie TUI palette — all colors sourced from charmtone.
// These are set by ApplyTheme and read by style builders.
var (
	colorAccent  color.Color
	colorUser    color.Color
	colorMemory  color.Color
	colorSystem  color.Color
	colorMuted   color.Color
	colorDim     color.Color
	colorSubtle  color.Color
	colorSurface color.Color
)

func init() {
	ApplyTheme(ThemeDark)
}

// ApplyTheme sets all palette colors for the given mode and rebuilds styles.
func ApplyTheme(mode ThemeMode) {
	CurrentTheme = mode
	switch mode {
	case ThemeLight:
		colorAccent = lipgloss.Color(charmtone.Pickle.Hex())  // darker teal
		colorUser = lipgloss.Color(charmtone.Oceania.Hex())   // darker blue
		colorMemory = lipgloss.Color(charmtone.Prince.Hex())  // darker purple
		colorSystem = lipgloss.Color(charmtone.Tang.Hex())    // warm orange (same)
		colorMuted = lipgloss.Color(charmtone.Squid.Hex())    // gray (same)
		colorDim = lipgloss.Color(charmtone.Smoke.Hex())      // lighter gray
		colorSubtle = lipgloss.Color(charmtone.Ash.Hex())     // light gray (borders)
		colorSurface = lipgloss.Color(charmtone.Salt.Hex())   // very light surface
	default: // ThemeDark
		colorAccent = lipgloss.Color(charmtone.Guac.Hex())    // teal primary
		colorUser = lipgloss.Color(charmtone.Anchovy.Hex())   // blue
		colorMemory = lipgloss.Color(charmtone.Orchid.Hex())  // purple
		colorSystem = lipgloss.Color(charmtone.Tang.Hex())    // warm orange
		colorMuted = lipgloss.Color(charmtone.Squid.Hex())    // gray (labels, thinking)
		colorDim = lipgloss.Color(charmtone.Oyster.Hex())     // dim gray (results, status)
		colorSubtle = lipgloss.Color(charmtone.Iron.Hex())    // darker gray (borders, scrollbar)
		colorSurface = lipgloss.Color(charmtone.Charcoal.Hex()) // dark surface (input border)
	}
	rebuildViewStyles()
	rebuildDialogStyles()
	rebuildAnimStyles()
	rebuildScrollbarStyles()
}

// ToggleTheme switches between dark and light mode.
func ToggleTheme() {
	if CurrentTheme == ThemeDark {
		ApplyTheme(ThemeLight)
	} else {
		ApplyTheme(ThemeDark)
	}
}

// ThemeBgHex returns the background color hex for the current theme,
// used for OSC 11 terminal background signaling.
func ThemeBgHex() string {
	if CurrentTheme == ThemeLight {
		return "#f5f5f4" // stone-100 — matches FE light bg
	}
	return "#0a0a0a" // neutral-950 — matches FE dark bg
}
