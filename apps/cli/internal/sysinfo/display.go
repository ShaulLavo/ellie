package sysinfo

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/exp/charmtone"
)

var (
	// Palette — reuse charmtone colors consistent with the rest of the CLI.
	colorAccent = lipgloss.Color(charmtone.Guac.Hex())
	colorMuted  = lipgloss.Color(charmtone.Squid.Hex())
	colorValue  = lipgloss.Color(charmtone.Oyster.Hex())
	keyStyle = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true).
			Width(12).
			Align(lipgloss.Right)

	sepStyle = lipgloss.NewStyle().
			Foreground(colorMuted)

	valStyle = lipgloss.NewStyle().
			Foreground(colorValue)

	// Apple rainbow gradient — green, yellow, red, magenta, blue (top to bottom).
	logoColors = []color.Color{
		lipgloss.Color("#34C759"), // green
		lipgloss.Color("#FFCC00"), // yellow
		lipgloss.Color("#FF3B30"), // red
		lipgloss.Color("#AF52DE"), // magenta
		lipgloss.Color("#007AFF"), // blue
	}
)

// keyLabels maps ReadoutKey to its display label.
var keyLabels = map[ReadoutKey]string{
	KeyHost:     "Host",
	KeyMachine:  "Machine",
	KeyKernel:   "Kernel",
	KeyOS:       "OS",
	KeyDistro:   "Distro",
	KeyDE:       "DE",
	KeyWM:       "WM",
	KeyCPU:      "CPU",
	KeyCPULoad:  "CPU Load",
	KeyMemory:   "Memory",
	KeyBattery:  "Battery",
	KeyShell:    "Shell",
	KeyTerminal: "Terminal",
	KeyLocalIP:  "Local IP",
	KeyDisk:     "Disk",
	KeyUptime:   "Uptime",
	KeyPackages: "Packages",
}

// Render produces the styled output string with ASCII logo beside the info.
func Render(info Info) string {
	// Build info lines
	var lines []string
	for _, r := range info.Readouts {
		if r.Err != nil {
			continue
		}
		label := keyLabels[r.Key]
		line := keyStyle.Render(label) +
			sepStyle.Render(" ~ ") +
			valStyle.Render(r.Value)
		lines = append(lines, line)
	}

	infoBlock := strings.Join(lines, "\n")

	// Get logo
	logoLines := Logo()
	if len(logoLines) == 0 {
		return infoBlock + "\n"
	}

	// Color the logo with rainbow gradient (3 lines per color band)
	linesPerBand := len(logoLines) / len(logoColors)
	if linesPerBand < 1 {
		linesPerBand = 1
	}
	var coloredLogo []string
	for i, l := range logoLines {
		band := i / linesPerBand
		if band >= len(logoColors) {
			band = len(logoColors) - 1
		}
		style := lipgloss.NewStyle().Foreground(logoColors[band]).MarginRight(3)
		coloredLogo = append(coloredLogo, style.Render(l))
	}
	logoBlock := strings.Join(coloredLogo, "\n")

	// Join horizontally: logo on left, info on right
	return lipgloss.JoinHorizontal(lipgloss.Top, logoBlock, infoBlock) + "\n"
}
