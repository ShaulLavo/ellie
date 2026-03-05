//go:build tools
// +build tools

package cli

import (
	_ "charm.land/bubbles/v2/help"
	_ "charm.land/bubbletea/v2"
	_ "charm.land/glamour/v2"
	_ "charm.land/lipgloss/v2"
	_ "github.com/charmbracelet/harmonica"
	_ "github.com/charmbracelet/huh"
	_ "github.com/charmbracelet/wish"
)
