package chatui

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// focusState tracks which pane has focus.
type focusState int

const (
	focusEditor focusState = iota
	focusChat
)

// Model is the top-level Bubble Tea model for the chat TUI.
type Model struct {
	// Config
	baseURL       string
	sessionID     string
	transcriptDir string
	keys          KeyMap

	// Clients
	httpClient *HTTPClient
	sseClient  *SSEClient
	sseCancel  context.CancelFunc

	// Connection
	connState ConnectionState
	connError string

	// Chat state
	messages       []StoredMessage
	streamingMsg   *StoredMessage
	stats          SessionStats
	isAgentRunning bool
	allEvents      []EventRow // kept for stats recomputation

	// UI components
	textarea textarea.Model
	viewport viewport.Model
	focus    focusState
	width    int
	height   int
	ready    bool

	// Dialog
	dialog Dialog

	// History
	history *PromptHistory

	// Auto-scroll
	autoScroll bool
}

// NewModel creates a new chat TUI model.
func NewModel(baseURL, sessionID, transcriptDir string) Model {
	ta := textarea.New()
	ta.Placeholder = "Type a message..."
	ta.Focus()
	ta.CharLimit = 0
	ta.ShowLineNumbers = false
	ta.SetHeight(3)

	vp := viewport.New(80, 20)
	vp.SetContent("")

	return Model{
		baseURL:       baseURL,
		sessionID:     sessionID,
		transcriptDir: transcriptDir,
		keys:          DefaultKeyMap(),
		httpClient:    NewHTTPClient(baseURL),
		sseClient:     NewSSEClient(baseURL, sessionID),
		textarea:      ta,
		viewport:      vp,
		focus:         focusEditor,
		history:       NewPromptHistory(),
		autoScroll:    true,
	}
}

// ─── Bubble Tea interface ─────────────────────────────────────────

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		textarea.Blink,
		m.sseClient.Subscribe(),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.ready = true
		m.resizeComponents()
		return m, nil

	case tea.KeyMsg:
		// Quit
		if key.Matches(msg, m.keys.Quit) {
			m.cleanup()
			return m, tea.Quit
		}

		// Dialog gets priority
		if m.dialog != nil {
			return m.updateDialog(msg)
		}

		// Global shortcuts
		switch {
		case key.Matches(msg, m.keys.Commands):
			m.dialog = NewCommandPaletteDialog()
			return m, nil

		case key.Matches(msg, m.keys.Sessions):
			return m.openSessionsDialog()

		case key.Matches(msg, m.keys.Info):
			return m.openInfoDialog()

		case key.Matches(msg, m.keys.Escape):
			if m.focus == focusChat {
				m.focus = focusEditor
				m.textarea.Focus()
				return m, nil
			}
			// In editor: try escape from history
			if text, ok := m.history.EscapeToDraft(); ok {
				m.textarea.Reset()
				m.textarea.SetValue(text)
				return m, nil
			}
			return m, nil

		case key.Matches(msg, m.keys.Retry):
			if m.focus == focusChat && m.connState == StateError {
				m.sseClient.ResetRetry()
				return m, m.startSSE()
			}
		}

		// Focus-specific handling
		if m.focus == focusEditor {
			return m.updateEditor(msg)
		}
		return m.updateChat(msg)

	// ── SSE events ────────────────────────────────────────────

	case sseStateMsg:
		m.connState = msg.State
		if msg.State == StateConnected {
			m.connError = ""
		}
		return m, nil

	case sseErrorMsg:
		m.connError = msg.Message
		return m, nil

	case sseSnapshotMsg:
		return m.handleSnapshot(msg.Events)

	case sseAppendMsg:
		return m.handleAppend(msg.Event)

	case sseUpdateMsg:
		return m.handleUpdate(msg.Event)

	// ── Async results ─────────────────────────────────────────

	case sessionsLoadedMsg:
		if d, ok := m.dialog.(*SessionListDialog); ok {
			d.SetSessions(msg.sessions)
		}
		return m, nil

	case sessionInfoLoadedMsg:
		if d, ok := m.dialog.(*SessionInfoDialog); ok {
			d.SetData(msg.session, msg.stats)
		}
		return m, nil

	case clearDoneMsg:
		if msg.err != nil {
			m.connError = "Clear failed: " + msg.err.Error()
		} else {
			m.messages = nil
			m.streamingMsg = nil
			m.allEvents = nil
			m.stats = SessionStats{}
			m.isAgentRunning = false
			m.refreshViewport()
		}
		return m, nil

	case sendDoneMsg:
		if msg.err != nil {
			m.connError = "Send failed: " + msg.err.Error()
		}
		return m, nil

	case transcriptDoneMsg:
		if msg.err != nil {
			m.connError = "Transcript failed: " + msg.err.Error()
		}
		// TODO: show success notification with msg.path
		return m, nil
	}

	return m, tea.Batch(cmds...)
}

func (m Model) View() string {
	if !m.ready {
		return "Initializing..."
	}

	statusLine := renderStatusLine(&m, m.width)
	footer := renderFooter(&m, m.width)

	// Calculate viewport height
	statusH := lipgloss.Height(statusLine)
	footerH := lipgloss.Height(footer)
	inputH := lipgloss.Height(m.renderInput())
	vpHeight := m.height - statusH - footerH - inputH
	if vpHeight < 1 {
		vpHeight = 1
	}
	m.viewport.Height = vpHeight
	m.viewport.Width = m.width

	// Build dialog overlay
	var dialogView string
	if m.dialog != nil {
		dialogView = m.dialog.View(m.width, m.height)
	}

	// Layout
	var b strings.Builder
	b.WriteString(statusLine)
	b.WriteString("\n")
	b.WriteString(m.viewport.View())
	b.WriteString("\n")
	b.WriteString(m.renderInput())
	if footer != "" {
		b.WriteString("\n")
		b.WriteString(footer)
	}

	view := b.String()

	// Overlay dialog centered on screen
	if dialogView != "" {
		view = overlayCenter(view, dialogView, m.width, m.height)
	}

	return view
}

// ─── Editor handling ──────────────────────────────────────────────

func (m Model) updateEditor(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Editor.Send):
		return m.handleSend()

	case key.Matches(msg, m.keys.Editor.Newline):
		m.textarea.InsertString("\n")
		return m, nil

	case key.Matches(msg, m.keys.Editor.HistoryPrev):
		return m.handleHistoryUp(msg)

	case key.Matches(msg, m.keys.Editor.HistoryNext):
		return m.handleHistoryDown(msg)
	}

	// Pass to textarea
	oldVal := m.textarea.Value()
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)

	// Track draft changes for history
	if m.textarea.Value() != oldVal {
		m.history.UpdateDraft(m.textarea.Value())
	}

	return m, cmd
}

func (m Model) handleSend() (tea.Model, tea.Cmd) {
	text := strings.TrimSpace(m.textarea.Value())
	if text == "" {
		return m, nil
	}

	// Check for slash command
	if cmd := matchSlashCommand(text); cmd != nil {
		m.textarea.Reset()
		m.history.Reset()
		return m.executeCommand(cmd)
	}

	// Cannot send if not connected
	if m.connState != StateConnected {
		return m, nil
	}

	// Save to history and clear
	m.history.Add(text)
	m.textarea.Reset()
	m.autoScroll = true

	return m, m.sendMessage(text)
}

// handleHistoryUp navigates up in prompt history.
// Ported from Crush history.go — boundary-aware.
func (m Model) handleHistoryUp(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// At top of editor or empty: enter history
	if m.textarea.Value() == "" || isAtEditorStart(m.textarea) {
		if text, ok := m.history.Prev(m.textarea.Value()); ok {
			m.textarea.Reset()
			m.textarea.SetValue(text)
			return m, nil
		}
	}
	// Otherwise let textarea handle cursor movement
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)
	return m, cmd
}

// handleHistoryDown navigates down in prompt history.
func (m Model) handleHistoryDown(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if isAtEditorEnd(m.textarea) {
		if text, ok := m.history.Next(); ok {
			m.textarea.Reset()
			m.textarea.SetValue(text)
			return m, nil
		}
	}
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)
	return m, cmd
}

// ─── Chat viewport handling ───────────────────────────────────────

func (m Model) updateChat(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Tab back to editor
	if key.Matches(msg, key.NewBinding(key.WithKeys("tab"))) {
		m.focus = focusEditor
		m.textarea.Focus()
		return m, nil
	}

	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)

	// If user scrolled up, disable auto-scroll
	if m.viewport.AtBottom() {
		m.autoScroll = true
	} else {
		m.autoScroll = false
	}

	return m, cmd
}

// ─── Dialog handling ──────────────────────────────────────────────

func (m Model) updateDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	newDialog, action := m.dialog.Update(msg, m.keys)
	m.dialog = newDialog

	switch action {
	case ActionClose:
		m.dialog = nil
		return m, nil

	case ActionClearSession:
		m.dialog = nil
		return m, m.clearSession()

	case ActionSelectCommand:
		if cp, ok := m.dialog.(*CommandPaletteDialog); ok {
			if sel := cp.Selected(); sel != nil {
				m.dialog = nil
				return m.executeCommand(sel)
			}
		}
		m.dialog = nil
		return m, nil
	}

	return m, nil
}

// ─── SSE event handlers ──────────────────────────────────────────

func (m Model) handleSnapshot(events []EventRow) (tea.Model, tea.Cmd) {
	m.allEvents = events

	// Filter to renderable events and project to messages
	var msgs []StoredMessage
	for _, ev := range events {
		if !IsRenderable(ev.Type) {
			continue
		}
		stored := EventToStored(ev)
		if len(stored.Parts) == 0 && stored.Text == "" {
			continue
		}
		msgs = append(msgs, stored)
	}
	m.messages = msgs

	// Check for streaming message
	m.streamingMsg = nil
	for _, ev := range events {
		if ev.Type != "assistant_message" {
			continue
		}
		parsed := parsePayload(ev.Payload)
		if b, ok := parsed["streaming"].(bool); ok && b {
			stored := EventToStored(ev)
			stored.IsStreaming = true
			m.streamingMsg = &stored
		}
	}

	// Compute stats
	m.stats = ComputeStatsFromEvents(events)
	m.isAgentRunning = IsAgentRunOpen(events)

	m.refreshViewport()
	return m, nil
}

func (m Model) handleAppend(ev EventRow) (tea.Model, tea.Cmd) {
	m.allEvents = append(m.allEvents, ev)

	// Agent lifecycle
	if IsAgentStart(ev.Type) {
		m.isAgentRunning = true
	} else if IsAgentEnd(ev.Type) {
		m.isAgentRunning = false
	}

	// assistant_message append: create streaming placeholder
	if ev.Type == "assistant_message" {
		m.streamingMsg = &StoredMessage{
			ID:          fmt.Sprintf("%d", ev.ID),
			Timestamp:   "",
			Text:        "",
			Parts:       nil,
			Seq:         ev.Seq,
			Sender:      SenderAgent,
			IsStreaming: true,
		}
		m.refreshViewport()
		return m, nil
	}

	// user_message: update stats
	if ev.Type == "user_message" {
		delta := ComputeStatsFromEvents([]EventRow{ev})
		m.stats = MergeStats(m.stats, delta)
	}

	// Renderable events
	if !IsRenderable(ev.Type) {
		return m, nil
	}

	stored := EventToStored(ev)
	if len(stored.Parts) == 0 && stored.Text == "" {
		return m, nil
	}
	m.messages = append(m.messages, stored)
	m.refreshViewport()
	return m, nil
}

func (m Model) handleUpdate(ev EventRow) (tea.Model, tea.Cmd) {
	// Upsert into allEvents by ID.
	m.upsertEvent(ev)

	if ev.Type == "assistant_message" {
		parsed := parsePayload(ev.Payload)
		streaming, _ := parsed["streaming"].(bool)
		stored := EventToStored(ev)

		if streaming {
			stored.IsStreaming = true
			m.streamingMsg = &stored
		} else {
			// Finalized — move to messages, clear streaming
			m.streamingMsg = nil
			m.upsertMessage(stored)

			// Recompute stats from all events for accuracy.
			m.stats = ComputeStatsFromEvents(m.allEvents)
		}
		m.refreshViewport()
		return m, nil
	}

	if ev.Type == "tool_execution" {
		stored := EventToStored(ev)
		if len(stored.Parts) == 0 && stored.Text == "" {
			return m, nil
		}
		m.upsertMessage(stored)
		m.refreshViewport()
		return m, nil
	}

	return m, nil
}

// upsertEvent replaces an existing EventRow by ID, or appends if new.
func (m *Model) upsertEvent(ev EventRow) {
	for i, e := range m.allEvents {
		if e.ID == ev.ID {
			m.allEvents[i] = ev
			return
		}
	}
	m.allEvents = append(m.allEvents, ev)
}

// upsertMessage replaces an existing StoredMessage by ID, or appends if new.
func (m *Model) upsertMessage(stored StoredMessage) {
	for i, msg := range m.messages {
		if msg.ID == stored.ID {
			m.messages[i] = stored
			return
		}
	}
	m.messages = append(m.messages, stored)
}

// ─── Commands ─────────────────────────────────────────────────────

func (m Model) executeCommand(cmd *SlashCommand) (tea.Model, tea.Cmd) {
	switch cmd.Name {
	case "clear":
		m.dialog = NewClearConfirmDialog()
		return m, nil
	case "sessions":
		return m.openSessionsDialog()
	case "info":
		return m.openInfoDialog()
	case "transcript":
		return m, m.saveTranscript()
	default:
		return m, nil
	}
}

func (m Model) openSessionsDialog() (tea.Model, tea.Cmd) {
	dlg := NewSessionListDialog(m.sessionID)
	m.dialog = dlg
	return m, m.loadSessions(dlg)
}

func (m Model) openInfoDialog() (tea.Model, tea.Cmd) {
	dlg := NewSessionInfoDialog()
	m.dialog = dlg
	return m, m.loadSessionInfo(dlg)
}

// ─── Async commands (tea.Cmd) ─────────────────────────────────────

type sessionsLoadedMsg struct {
	sessions []SessionEntry
}

type sessionInfoLoadedMsg struct {
	session *SessionEntry
	stats   SessionStats
}

type clearDoneMsg struct{ err error }
type sendDoneMsg struct{ err error }
type transcriptDoneMsg struct {
	path string
	err  error
}

func (m *Model) startSSE() tea.Cmd {
	// Cancel any existing loop.
	if m.sseCancel != nil {
		m.sseCancel()
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.sseCancel = cancel

	client := m.sseClient
	return func() tea.Msg {
		// RunLoop blocks until it gives up or the context is cancelled.
		// sendFn is stored on the client from the initial StartSSELoop call.
		client.mu.Lock()
		send := client.sendFn
		client.mu.Unlock()
		if send != nil {
			client.RunLoop(ctx, send)
		}
		return nil
	}
}

// StartSSELoop starts the SSE event loop. Called from cmd_chat after
// the program is created, since we need Program.Send.
func (m *Model) StartSSELoop(ctx context.Context, send func(tea.Msg)) {
	m.sseClient.RunLoop(ctx, send)
}

func (m Model) sendMessage(text string) tea.Cmd {
	return func() tea.Msg {
		err := m.httpClient.SendMessage(context.Background(), m.sessionID, text)
		return sendDoneMsg{err: err}
	}
}

func (m Model) clearSession() tea.Cmd {
	return func() tea.Msg {
		err := m.httpClient.ClearSession(context.Background(), m.sessionID)
		return clearDoneMsg{err: err}
	}
}

func (m Model) loadSessions(dlg *SessionListDialog) tea.Cmd {
	return func() tea.Msg {
		sessions, err := m.httpClient.ListSessions(context.Background())
		if err != nil {
			return sessionsLoadedMsg{sessions: nil}
		}
		return sessionsLoadedMsg{sessions: sessions}
	}
}

func (m Model) loadSessionInfo(dlg *SessionInfoDialog) tea.Cmd {
	return func() tea.Msg {
		session, err := m.httpClient.GetCurrentSession(context.Background())
		if err != nil {
			return sessionInfoLoadedMsg{session: nil}
		}
		stats := ComputeStatsFromEvents(m.allEvents)
		return sessionInfoLoadedMsg{session: session, stats: stats}
	}
}

func (m Model) saveTranscript() tea.Cmd {
	msgs := m.messages
	sid := m.sessionID
	dir := m.transcriptDir
	return func() tea.Msg {
		path, err := SaveTranscript(msgs, sid, dir)
		return transcriptDoneMsg{path: path, err: err}
	}
}

// ─── Layout helpers ───────────────────────────────────────────────

func (m *Model) resizeComponents() {
	m.textarea.SetWidth(m.width - 4)

	statusH := 1 // status line
	footerH := 1 // footer
	inputH := 5  // textarea with border
	vpHeight := m.height - statusH - footerH - inputH
	if vpHeight < 1 {
		vpHeight = 1
	}
	m.viewport.Width = m.width
	m.viewport.Height = vpHeight
	m.refreshViewport()
}

func (m *Model) refreshViewport() {
	content := renderMessages(m, m.width)
	m.viewport.SetContent(content)
	if m.autoScroll {
		m.viewport.GotoBottom()
	}
}

func (m Model) renderInput() string {
	style := inputBorder
	if m.focus == focusEditor {
		style = inputBorderFocused
	}
	return style.Width(m.width - 4).Render(m.textarea.View())
}

func (m *Model) cleanup() {
	m.sseClient.Disconnect()
	if m.sseCancel != nil {
		m.sseCancel()
	}
}

// ─── Slash command matching ───────────────────────────────────────

func matchSlashCommand(text string) *SlashCommand {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, " ") {
		return nil
	}
	for _, cmd := range Commands {
		if "/"+cmd.Name == trimmed {
			return &cmd
		}
	}
	return nil
}

// ─── Editor boundary checks (ported from Crush) ──────────────────

func isAtEditorStart(ta textarea.Model) bool {
	return ta.Line() == 0
}

func isAtEditorEnd(ta textarea.Model) bool {
	return ta.Line() >= ta.LineCount()-1
}

// ─── Overlay helper ───────────────────────────────────────────────

func overlayCenter(bg, fg string, width, height int) string {
	bgLines := strings.Split(bg, "\n")
	fgLines := strings.Split(fg, "\n")

	fgW := 0
	for _, l := range fgLines {
		if w := lipgloss.Width(l); w > fgW {
			fgW = w
		}
	}

	startY := (height - len(fgLines)) / 2
	startX := (width - fgW) / 2
	if startY < 0 {
		startY = 0
	}
	if startX < 0 {
		startX = 0
	}

	// Ensure bg has enough lines
	for len(bgLines) < height {
		bgLines = append(bgLines, "")
	}

	for i, fgLine := range fgLines {
		y := startY + i
		if y >= len(bgLines) {
			break
		}
		bgLine := bgLines[y]
		// Pad background line if needed
		for lipgloss.Width(bgLine) < startX {
			bgLine += " "
		}
		// Replace portion with dialog line
		bgLines[y] = bgLine[:startX] + fgLine
	}

	return strings.Join(bgLines, "\n")
}
