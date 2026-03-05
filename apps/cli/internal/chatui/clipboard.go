package chatui

import (
	tea "charm.land/bubbletea/v2"
	"github.com/atotto/clipboard"
)

// copyToClipboard copies text using both OSC 52 (terminal escape sequence via
// tea.SetClipboard) and the native OS clipboard for maximum compatibility.
func copyToClipboard(text string) tea.Cmd {
	return tea.Sequence(
		tea.SetClipboard(text),
		func() tea.Msg {
			_ = clipboard.WriteAll(text)
			return nil
		},
	)
}
