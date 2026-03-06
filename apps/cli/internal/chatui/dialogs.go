package chatui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// Dialog is the interface for modal overlays.
type Dialog interface {
	Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction)
	View(width, height int) string
}

// DialogAction is returned from dialog updates to signal the parent model.
type DialogAction int

const (
	ActionNone DialogAction = iota
	ActionClose
	ActionClearSession
	ActionSelectCommand
	ActionRetry
)

// dialogStyles holds shared dialog styling — rebuilt by rebuildDialogStyles() on theme change.
var (
	dialogBorder    lipgloss.Style
	dialogTitle     lipgloss.Style
	dialogDim       lipgloss.Style
	dialogHighlight lipgloss.Style
)

func rebuildDialogStyles() {
	dialogBorder = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorSubtle).
		Padding(1, 2)
	dialogTitle = lipgloss.NewStyle().
		Bold(true).
		Foreground(colorAccent)
	dialogDim = lipgloss.NewStyle().
		Foreground(colorDim)
	dialogHighlight = lipgloss.NewStyle().
		Foreground(colorAccent).
		Bold(true)
}

// ─── Command Palette ──────────────────────────────────────────────

// CommandPaletteDialog shows a filterable list of slash commands.
type CommandPaletteDialog struct {
	commands []SlashCommand
	filter   textinput.Model
	cursor   int
	selected *SlashCommand
}

// NewCommandPaletteDialog creates a command palette.
func NewCommandPaletteDialog() *CommandPaletteDialog {
	ti := textinput.New()
	ti.Placeholder = "Search commands..."
	ti.Focus()
	return &CommandPaletteDialog{
		commands: Commands,
		filter:   ti,
	}
}

func (d *CommandPaletteDialog) filtered() []SlashCommand {
	q := strings.ToLower(d.filter.Value())
	if q == "" {
		return d.commands
	}
	var out []SlashCommand
	for _, c := range d.commands {
		if strings.Contains(strings.ToLower(c.Name), q) ||
			strings.Contains(strings.ToLower(c.Description), q) {
			out = append(out, c)
		}
	}
	return out
}

func (d *CommandPaletteDialog) Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction) {
	km, ok := msg.(tea.KeyMsg)
	if !ok {
		return d, ActionNone
	}

	switch {
	case key.Matches(km, keys.Escape):
		return nil, ActionClose
	case key.Matches(km, keys.Editor.Send):
		items := d.filtered()
		if len(items) > 0 && d.cursor < len(items) {
			d.selected = &items[d.cursor]
			return nil, ActionSelectCommand
		}
		return d, ActionNone
	case key.Matches(km, keys.Chat.Up):
		if d.cursor > 0 {
			d.cursor--
		}
		return d, ActionNone
	case key.Matches(km, keys.Chat.Down):
		items := d.filtered()
		if d.cursor < len(items)-1 {
			d.cursor++
		}
		return d, ActionNone
	}

	// Update the filter text input
	newTi, _ := d.filter.Update(msg)
	d.filter = newTi
	// Reset cursor when filter changes
	items := d.filtered()
	if d.cursor >= len(items) {
		d.cursor = max(0, len(items)-1)
	}

	return d, ActionNone
}

func (d *CommandPaletteDialog) View(width, height int) string {
	var b strings.Builder
	b.WriteString(dialogTitle.Render("Commands"))
	b.WriteString("\n\n")
	b.WriteString(d.filter.View())
	b.WriteString("\n\n")

	items := d.filtered()
	for i, cmd := range items {
		prefix := "  "
		if i == d.cursor {
			prefix = dialogHighlight.Render("> ")
		}
		name := "/" + cmd.Name
		if i == d.cursor {
			name = dialogHighlight.Render(name)
		}
		b.WriteString(fmt.Sprintf("%s%-15s %s\n", prefix, name, dialogDim.Render(cmd.Description)))
	}

	if len(items) == 0 {
		b.WriteString(dialogDim.Render("  No matching commands"))
	}

	maxW := clampDialogWidth(width, 60)
	return dialogBorder.Width(maxW).Render(b.String())
}

// Selected returns the command selected by the user, if any.
func (d *CommandPaletteDialog) Selected() *SlashCommand {
	return d.selected
}

// ─── Session List Dialog ──────────────────────────────────────────

// SessionListDialog shows the list of sessions (read-only in v1).
type SessionListDialog struct {
	sessions  []SessionEntry
	currentID string
	cursor    int
	loading   bool
}

// NewSessionListDialog creates a session list dialog.
func NewSessionListDialog(currentID string) *SessionListDialog {
	return &SessionListDialog{
		currentID: currentID,
		loading:   true,
	}
}

// SetSessions updates the dialog with fetched sessions.
func (d *SessionListDialog) SetSessions(sessions []SessionEntry) {
	d.sessions = sessions
	d.loading = false
}

func (d *SessionListDialog) Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction) {
	km, ok := msg.(tea.KeyMsg)
	if !ok {
		return d, ActionNone
	}

	switch {
	case key.Matches(km, keys.Escape):
		return nil, ActionClose
	case key.Matches(km, keys.Chat.Up):
		if d.cursor > 0 {
			d.cursor--
		}
	case key.Matches(km, keys.Chat.Down):
		if d.cursor < len(d.sessions)-1 {
			d.cursor++
		}
	}
	return d, ActionNone
}

func (d *SessionListDialog) View(width, height int) string {
	var b strings.Builder
	b.WriteString(dialogTitle.Render("Sessions"))
	b.WriteString("\n\n")

	if d.loading {
		b.WriteString(dialogDim.Render("  Loading..."))
		maxW := clampDialogWidth(width, 60)
		return dialogBorder.Width(maxW).Render(b.String())
	}

	if len(d.sessions) == 0 {
		b.WriteString(dialogDim.Render("  No sessions found"))
		maxW := clampDialogWidth(width, 60)
		return dialogBorder.Width(maxW).Render(b.String())
	}

	for i, s := range d.sessions {
		prefix := "  "
		if i == d.cursor {
			prefix = dialogHighlight.Render("> ")
		}

		id := truncateID(s.ID)
		created := time.UnixMilli(s.CreatedAt).Format("2006-01-02 15:04")
		marker := ""
		if s.ID == d.currentID {
			marker = dialogHighlight.Render(" (current)")
		}

		line := fmt.Sprintf("%s%s  %s  %d events%s",
			prefix, id, dialogDim.Render(created), s.CurrentSeq, marker)
		b.WriteString(line + "\n")
	}

	maxW := clampDialogWidth(width, 70)
	return dialogBorder.Width(maxW).Render(b.String())
}

// ─── Session Info Dialog ──────────────────────────────────────────

// SessionInfoDialog shows details for the current session.
type SessionInfoDialog struct {
	session *SessionEntry
	stats   SessionStats
	loading bool
}

// NewSessionInfoDialog creates a session info dialog.
func NewSessionInfoDialog() *SessionInfoDialog {
	return &SessionInfoDialog{loading: true}
}

// SetData updates the dialog with session info.
func (d *SessionInfoDialog) SetData(session *SessionEntry, stats SessionStats) {
	d.session = session
	d.stats = stats
	d.loading = false
}

func (d *SessionInfoDialog) Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction) {
	km, ok := msg.(tea.KeyMsg)
	if !ok {
		return d, ActionNone
	}
	if key.Matches(km, keys.Escape) || key.Matches(km, keys.Editor.Send) {
		return nil, ActionClose
	}
	return d, ActionNone
}

func (d *SessionInfoDialog) View(width, height int) string {
	var b strings.Builder
	b.WriteString(dialogTitle.Render("Session Info"))
	b.WriteString("\n\n")

	if d.loading {
		b.WriteString(dialogDim.Render("  Loading..."))
		maxW := clampDialogWidth(width, 50)
		return dialogBorder.Width(maxW).Render(b.String())
	}

	if d.session == nil {
		b.WriteString(dialogDim.Render("  No session data"))
		maxW := clampDialogWidth(width, 50)
		return dialogBorder.Width(maxW).Render(b.String())
	}

	b.WriteString(fmt.Sprintf("  Session ID:   %s\n", d.session.ID))
	b.WriteString(fmt.Sprintf("  Events:       %d\n", d.session.CurrentSeq))
	b.WriteString(fmt.Sprintf("  Created:      %s\n",
		time.UnixMilli(d.session.CreatedAt).Format("2006-01-02 15:04:05")))
	b.WriteString(fmt.Sprintf("  Updated:      %s\n",
		time.UnixMilli(d.session.UpdatedAt).Format("2006-01-02 15:04:05")))

	if d.stats.Model != nil {
		b.WriteString(fmt.Sprintf("  Model:        %s\n", *d.stats.Model))
	}
	if d.stats.Provider != nil {
		b.WriteString(fmt.Sprintf("  Provider:     %s\n", *d.stats.Provider))
	}
	b.WriteString(fmt.Sprintf("  Messages:     %d\n", d.stats.MessageCount))
	b.WriteString(fmt.Sprintf("  Prompt tok:   %d\n", d.stats.PromptTokens))
	b.WriteString(fmt.Sprintf("  Compl. tok:   %d\n", d.stats.CompletionTokens))
	if d.stats.TotalCost > 0 {
		b.WriteString(fmt.Sprintf("  Cost:         $%.4f\n", d.stats.TotalCost))
	}

	maxW := clampDialogWidth(width, 50)
	return dialogBorder.Width(maxW).Render(b.String())
}

// ─── Clear Confirmation Dialog ────────────────────────────────────

// ClearConfirmDialog asks for confirmation before clearing the session.
type ClearConfirmDialog struct{}

func NewClearConfirmDialog() *ClearConfirmDialog {
	return &ClearConfirmDialog{}
}

func (d *ClearConfirmDialog) Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction) {
	km, ok := msg.(tea.KeyMsg)
	if !ok {
		return d, ActionNone
	}
	switch {
	case key.Matches(km, keys.Escape),
		key.Matches(km, key.NewBinding(key.WithKeys("n", "N"))):
		return nil, ActionClose
	case key.Matches(km, key.NewBinding(key.WithKeys("y", "Y"))):
		return nil, ActionClearSession
	}
	return d, ActionNone
}

func (d *ClearConfirmDialog) View(width, height int) string {
	var b strings.Builder
	b.WriteString(dialogTitle.Render("Clear conversation"))
	b.WriteString("\n\n")
	b.WriteString("  This will start a new conversation.\n")
	b.WriteString("  Your current session will be saved.\n\n")
	b.WriteString(fmt.Sprintf("  %s / %s",
		dialogHighlight.Render("[Y]es"),
		dialogDim.Render("[N]o")))

	maxW := clampDialogWidth(width, 50)
	return dialogBorder.Width(maxW).Render(b.String())
}

// ─── Helpers ──────────────────────────────────────────────────────

// clampDialogWidth returns a safe dialog width: at least 10, at most limit,
// with 4 columns reserved for border/padding.
func clampDialogWidth(width, limit int) int {
	w := width - 4
	if w > limit {
		w = limit
	}
	if w < 10 {
		w = 10
	}
	return w
}

func truncateID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// ─── Disconnect Overlay ──────────────────────────────────────────

// DisconnectDialog is shown when the server becomes unreachable.
// It cannot be dismissed with Escape — only retry or reconnection clears it.
type DisconnectDialog struct {
	state ConnectionState
	err   string
}

// NewDisconnectDialog creates a disconnect overlay.
func NewDisconnectDialog(state ConnectionState, errMsg string) *DisconnectDialog {
	return &DisconnectDialog{state: state, err: errMsg}
}

// UpdateState refreshes the dialog with new connection info.
func (d *DisconnectDialog) UpdateState(state ConnectionState, errMsg string) {
	d.state = state
	d.err = errMsg
}

func (d *DisconnectDialog) Update(msg tea.Msg, keys KeyMap) (Dialog, DialogAction) {
	km, ok := msg.(tea.KeyMsg)
	if !ok {
		return d, ActionNone
	}
	// 'r' to retry — works in any disconnect state
	if key.Matches(km, key.NewBinding(key.WithKeys("r", "R"))) {
		return d, ActionRetry
	}
	// Non-dismissible: Escape does nothing
	return d, ActionNone
}

func (d *DisconnectDialog) View(width, height int) string {
	var b strings.Builder
	b.WriteString(dialogTitle.Render("Server Unreachable"))
	b.WriteString("\n\n")

	switch d.state {
	case StateError:
		b.WriteString("  ✕ Connection failed")
		if d.err != "" {
			b.WriteString("\n")
			b.WriteString(dialogDim.Render("  " + d.err))
		}
	case StateConnecting:
		b.WriteString(dialogDim.Render("  ◌ Reconnecting..."))
	default:
		b.WriteString(dialogDim.Render("  ○ Disconnected"))
	}

	b.WriteString("\n\n")
	b.WriteString(fmt.Sprintf("  Press %s to retry", dialogHighlight.Render("[R]")))

	maxW := clampDialogWidth(width, 50)
	return dialogBorder.Width(maxW).Render(b.String())
}
