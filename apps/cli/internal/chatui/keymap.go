package chatui

import "charm.land/bubbles/v2/key"

// KeyMap defines all key bindings for the chat TUI,
// inspired by Crush's hierarchical keymap structure.
type KeyMap struct {
	Editor struct {
		Send        key.Binding
		Newline     key.Binding
		FocusChat   key.Binding
		HistoryPrev key.Binding
		HistoryNext key.Binding
	}

	Chat struct {
		Up          key.Binding
		Down        key.Binding
		PageUp      key.Binding
		PageDown    key.Binding
		Home        key.Binding
		End         key.Binding
		FocusEditor key.Binding
		PlayAudio   key.Binding
	}

	Attachments struct {
		Left   key.Binding
		Right  key.Binding
		Remove key.Binding
		Cancel key.Binding
	}

	// Global bindings
	Quit     key.Binding
	Commands key.Binding
	Sessions key.Binding
	Info     key.Binding
	Theme    key.Binding
	Retry    key.Binding
	Escape   key.Binding
}

// DefaultKeyMap returns the default key bindings.
func DefaultKeyMap() KeyMap {
	km := KeyMap{
		Quit: key.NewBinding(
			key.WithKeys("ctrl+c"),
			key.WithHelp("ctrl+c", "quit"),
		),
		Commands: key.NewBinding(
			key.WithKeys("ctrl+p"),
			key.WithHelp("ctrl+p", "commands"),
		),
		Sessions: key.NewBinding(
			key.WithKeys("ctrl+s"),
			key.WithHelp("ctrl+s", "sessions"),
		),
		Info: key.NewBinding(
			key.WithKeys("ctrl+g"),
			key.WithHelp("ctrl+g", "info"),
		),
		Theme: key.NewBinding(
			key.WithKeys("ctrl+t"),
			key.WithHelp("ctrl+t", "theme"),
		),
		Retry: key.NewBinding(
			key.WithKeys("r"),
			key.WithHelp("r", "retry"),
		),
		Escape: key.NewBinding(
			key.WithKeys("esc"),
			key.WithHelp("esc", "back"),
		),
	}

	km.Editor.Send = key.NewBinding(
		key.WithKeys("enter"),
		key.WithHelp("enter", "send"),
	)
	km.Editor.Newline = key.NewBinding(
		key.WithKeys("shift+enter", "alt+enter"),
		key.WithHelp("shift+enter", "newline"),
	)
	km.Editor.FocusChat = key.NewBinding(
		key.WithKeys("tab"),
		key.WithHelp("tab", "chat"),
	)
	km.Editor.HistoryPrev = key.NewBinding(
		key.WithKeys("up"),
		key.WithHelp("↑", "history prev"),
	)
	km.Editor.HistoryNext = key.NewBinding(
		key.WithKeys("down"),
		key.WithHelp("↓", "history next"),
	)

	km.Chat.Up = key.NewBinding(
		key.WithKeys("up"),
		key.WithHelp("↑", "scroll up"),
	)
	km.Chat.Down = key.NewBinding(
		key.WithKeys("down"),
		key.WithHelp("↓", "scroll down"),
	)
	km.Chat.PageUp = key.NewBinding(
		key.WithKeys("pgup"),
		key.WithHelp("pgup", "page up"),
	)
	km.Chat.PageDown = key.NewBinding(
		key.WithKeys("pgdown"),
		key.WithHelp("pgdn", "page down"),
	)
	km.Chat.Home = key.NewBinding(
		key.WithKeys("home"),
		key.WithHelp("home", "top"),
	)
	km.Chat.End = key.NewBinding(
		key.WithKeys("end"),
		key.WithHelp("end", "bottom"),
	)
	km.Chat.FocusEditor = key.NewBinding(
		key.WithKeys("tab"),
		key.WithHelp("tab", "editor"),
	)
	km.Chat.PlayAudio = key.NewBinding(
		key.WithKeys("p"),
		key.WithHelp("p", "play/stop audio"),
	)

	km.Attachments.Left = key.NewBinding(
		key.WithKeys("left"),
		key.WithHelp("←", "prev"),
	)
	km.Attachments.Right = key.NewBinding(
		key.WithKeys("right"),
		key.WithHelp("→", "next"),
	)
	km.Attachments.Remove = key.NewBinding(
		key.WithKeys("delete", "backspace"),
		key.WithHelp("del", "remove"),
	)
	km.Attachments.Cancel = key.NewBinding(
		key.WithKeys("esc", "down", "enter"),
		key.WithHelp("esc", "back"),
	)

	return km
}
