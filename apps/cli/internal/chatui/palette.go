package chatui

import (
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/exp/charmtone"
)

// Ellie TUI palette — all colors sourced from charmtone.
var (
	colorAccent    = lipgloss.Color(charmtone.Guac.Hex())    // teal primary
	colorUser      = lipgloss.Color(charmtone.Anchovy.Hex()) // blue
	colorMemory    = lipgloss.Color(charmtone.Orchid.Hex())  // purple
	colorSystem    = lipgloss.Color(charmtone.Tang.Hex())     // warm orange
	colorMuted     = lipgloss.Color(charmtone.Squid.Hex())   // gray (labels, thinking)
	colorDim       = lipgloss.Color(charmtone.Oyster.Hex())  // dim gray (results, status)
	colorSubtle    = lipgloss.Color(charmtone.Iron.Hex())    // darker gray (borders, scrollbar)
	colorSurface   = lipgloss.Color(charmtone.Charcoal.Hex()) // dark surface (input border)
)
