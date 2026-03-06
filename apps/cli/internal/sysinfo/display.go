package sysinfo

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/exp/charmtone"
)

var (
	// Palette — reuse charmtone colors consistent with the rest of the CLI.
	colorAccent = lipgloss.Color(charmtone.Guac.Hex())
	colorMuted  = lipgloss.Color(charmtone.Squid.Hex())
	colorValue  = lipgloss.Color(charmtone.Oyster.Hex())
	colorLogo   = lipgloss.Color(charmtone.Anchovy.Hex())

	keyStyle = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true).
			Width(12).
			Align(lipgloss.Right)

	sepStyle = lipgloss.NewStyle().
			Foreground(colorMuted)

	valStyle = lipgloss.NewStyle().
			Foreground(colorValue)

	logoStyle = lipgloss.NewStyle().
			Foreground(colorLogo).
			MarginRight(3)
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

	// Color the logo
	var coloredLogo []string
	for _, l := range logoLines {
		coloredLogo = append(coloredLogo, logoStyle.Render(l))
	}
	logoBlock := strings.Join(coloredLogo, "\n")

	// Join horizontally: logo on left, info on right
	return lipgloss.JoinHorizontal(lipgloss.Top, logoBlock, infoBlock) + "\n"
}
