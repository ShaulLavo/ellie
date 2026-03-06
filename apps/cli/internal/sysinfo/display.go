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

	keyStyle = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true).
			Width(12).
			Align(lipgloss.Right)

	sepStyle = lipgloss.NewStyle().
			Foreground(colorMuted)

	valStyle = lipgloss.NewStyle().
			Foreground(colorValue)

	barStyle = lipgloss.NewStyle().
			Foreground(colorMuted)
)

// barKeys are readout keys that support bar visualization.
var barKeys = map[ReadoutKey]bool{
	KeyCPULoad: true,
	KeyMemory:  true,
	KeyDisk:    true,
	KeyBattery: true,
}

// keyLabels maps ReadoutKey to its display label.
var keyLabels = map[ReadoutKey]string{
	KeyHost:       "Host",
	KeyMachine:    "Machine",
	KeyKernel:     "Kernel",
	KeyOS:         "OS",
	KeyDistro:     "Distro",
	KeyDE:         "DE",
	KeyWM:         "WM",
	KeyCPU:        "CPU",
	KeyCPULoad:    "CPU Load",
	KeyMemory:     "Memory",
	KeyBattery:    "Battery",
	KeyGPU:        "GPU",
	KeyResolution: "Resolution",
	KeyShell:      "Shell",
	KeyTerminal:   "Terminal",
	KeyLocalIP:    "Local IP",
	KeyDisk:       "Disk",
	KeyUptime:     "Uptime",
	KeyPackages:   "Packages",
}

// RenderOpts controls how sysinfo is rendered.
type RenderOpts struct {
	SmallLogo bool
	ShowBars  bool
}

// Render produces the styled output string with ASCII logo beside the info.
func Render(info Info, opts RenderOpts) string {
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

		// Append bar visualization if enabled and applicable
		if opts.ShowBars && barKeys[r.Key] && r.Percent >= 0 {
			line += " " + barStyle.Render(FormatBar(r.Percent))
		}

		lines = append(lines, line)
	}

	infoBlock := strings.Join(lines, "\n")

	// Get logo for current OS
	var logo Logo
	if opts.SmallLogo {
		logo = SelectLogoSmall()
	} else {
		logo = SelectLogo()
	}
	if len(logo.Lines) == 0 {
		return infoBlock + "\n"
	}

	logoBlock := logo.Render()

	// Pad logo lines with margin
	logoWithMargin := lipgloss.NewStyle().MarginRight(3).Render(logoBlock)

	// Join horizontally: logo on left, info on right
	return lipgloss.JoinHorizontal(lipgloss.Top, logoWithMargin, infoBlock) + "\n"
}
