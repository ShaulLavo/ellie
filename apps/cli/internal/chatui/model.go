package chatui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// focusState tracks which pane has focus.
type focusState int

const (
	focusEditor focusState = iota
	focusChat
	focusAttachments
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

	// Mouse selection
	sel selectionState

	// Cached chat content lines (with ANSI) for selection math.
	contentLines []string

	// Scrollbar auto-hide state
	scrollbarVisible bool
	scrollbarHideID  int

	// Trackpad diagonal-swipe guard: timestamp of last vertical wheel event.
	// Horizontal wheel events arriving within this window are suppressed to
	// prevent accidental sideways drift during vertical scrolls.
	lastVerticalWheel time.Time

	// Last time we got any sign of life from the server (SSE event, etc.).
	// If recent enough, we skip the health poll HTTP request.
	lastServerActivity time.Time

	// Render cache for non-streaming messages (keyed by message ID).
	msgRenderCache      map[string]string
	msgRenderCacheWidth int

	// Active animations (tool calls and thinking spinner).
	activeAnims    map[string]*chatAnim // toolCallID or "thinking" → anim
	thinkingAnimID string               // key for the thinking anim

	// Inline autocomplete ghost for slash commands.
	ghostSuggestion string

	// Pending file attachments.
	attachments      []PendingAttachment
	attachmentCursor int
}

// NewModel creates a new chat TUI model.
func NewModel(baseURL, sessionID, transcriptDir string) Model {
	ta := textarea.New()
	ta.Placeholder = "Type a message..."
	ta.Focus()
	ta.CharLimit = 0
	ta.ShowLineNumbers = false
	ta.SetHeight(1)

	// Disable the textarea's built-in InsertNewline binding so that
	// enter/shift+enter reach our updateEditor handler instead.
	ta.KeyMap.InsertNewline.SetEnabled(false)

	// Clear the default black background on the cursor line and end-of-buffer
	// so the input is transparent against the terminal background.
	styles := ta.Styles()
	styles.Focused.CursorLine = lipgloss.NewStyle()
	styles.Focused.EndOfBuffer = lipgloss.NewStyle()
	styles.Blurred.CursorLine = lipgloss.NewStyle()
	styles.Blurred.EndOfBuffer = lipgloss.NewStyle()
	ta.SetStyles(styles)

	vp := viewport.New()
	vp.SetContent("")

	return Model{
		baseURL:        baseURL,
		sessionID:      sessionID,
		transcriptDir:  transcriptDir,
		keys:           DefaultKeyMap(),
		httpClient:     NewHTTPClient(baseURL),
		sseClient:      NewSSEClient(baseURL, sessionID),
		textarea:       ta,
		viewport:       vp,
		focus:          focusEditor,
		history:        NewPromptHistory(),
		autoScroll:     true,
		msgRenderCache: make(map[string]string),
		activeAnims:    make(map[string]*chatAnim),
		thinkingAnimID: "_thinking",
	}
}

// ─── Health poll ──────────────────────────────────────────────────

// healthPollMsg carries the result of a periodic /api/status check.
type healthPollMsg struct{ reachable bool }

const healthPollInterval = 1 * time.Second

func (m *Model) healthPollTick() tea.Cmd {
	client := m.httpClient
	lastActivity := m.lastServerActivity
	return tea.Tick(healthPollInterval, func(_ time.Time) tea.Msg {
		// Skip the HTTP call if we got any sign of life recently.
		if time.Since(lastActivity) < healthPollInterval {
			return healthPollMsg{reachable: true}
		}
		ctx, cancel := context.WithTimeout(context.Background(), healthPollInterval)
		defer cancel()
		_, err := client.GetStatus(ctx)
		return healthPollMsg{reachable: err == nil}
	})
}

// ─── Bubble Tea interface ─────────────────────────────────────────

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		textarea.Blink,
		m.sseClient.Subscribe(),
		m.healthPollTick(),
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

	case tea.MouseMsg:
		return m.handleMouseMsg(msg)

	case tea.PasteMsg:
		if m.dialog != nil {
			return m, nil
		}
		// Check if pasted content is file path(s) — add as attachments.
		if paths := parseFilePaths(msg.Content); len(paths) > 0 {
			for _, p := range paths {
				m.attachments = append(m.attachments, newPendingAttachment(p))
			}
			m.resizeComponents()
			return m, nil
		}
		// Regular text paste
		if m.focus == focusEditor {
			m.textarea.InsertString(msg.Content)
			m.history.UpdateDraft(m.textarea.Value())
			m.adjustTextareaHeight()
		}
		return m, nil

	case tea.KeyPressMsg:
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

		case key.Matches(msg, m.keys.Theme):
			return m.toggleTheme()

		case key.Matches(msg, m.keys.Escape):
			if m.focus == focusAttachments {
				m.focus = focusEditor
				m.textarea.Focus()
				return m, nil
			}
			if m.focus == focusChat {
				m.focus = focusEditor
				m.textarea.Focus()
				return m, nil
			}
			// In editor: try escape from history first
			if text, ok := m.history.EscapeToDraft(); ok {
				m.textarea.Reset()
				m.textarea.SetValue(text)
				return m, nil
			}
			// In editor with empty input: switch to chat viewport
			if strings.TrimSpace(m.textarea.Value()) == "" {
				m.focus = focusChat
				m.textarea.Blur()
				return m, nil
			}
			return m, nil

		case key.Matches(msg, m.keys.Retry):
			if m.connState == StateError {
				m.sseClient.ResetRetry()
				return m, m.startSSE()
			}
		}

		// Focus-specific handling
		switch m.focus {
		case focusEditor:
			return m.updateEditor(msg)
		case focusAttachments:
			return m.updateAttachments(msg)
		default:
			return m.updateChat(msg)
		}

	// ── SSE events ────────────────────────────────────────────

	case sseStateMsg:
		m.lastServerActivity = time.Now()
		m.connState = msg.State
		if msg.State == StateConnected {
			m.connError = ""
			// Auto-dismiss disconnect overlay on reconnection
			if _, ok := m.dialog.(*DisconnectDialog); ok {
				m.dialog = nil
			}
		} else {
			// Show disconnect overlay (or update existing one)
			if d, ok := m.dialog.(*DisconnectDialog); ok {
				d.UpdateState(msg.State, m.connError)
			} else if msg.State == StateError {
				// Show immediately on error
				m.dialog = NewDisconnectDialog(msg.State, m.connError)
			}
		}
		return m, nil

	case sseErrorMsg:
		m.connError = msg.Message
		// Show/update disconnect overlay when an error arrives
		if d, ok := m.dialog.(*DisconnectDialog); ok {
			d.UpdateState(m.connState, msg.Message)
		} else if m.connState != StateConnected {
			m.dialog = NewDisconnectDialog(m.connState, msg.Message)
		}
		return m, nil

	case healthPollMsg:
		if msg.reachable {
			m.lastServerActivity = time.Now()
		}
		if !msg.reachable && m.connState == StateConnected {
			// Server went away — show overlay immediately
			m.connState = StateConnecting
			m.dialog = NewDisconnectDialog(StateConnecting, "")
		} else if msg.reachable && m.connState != StateConnected {
			// Server is back — force reconnect now
			if d, ok := m.dialog.(*DisconnectDialog); ok {
				d.UpdateState(StateConnecting, "")
			}
			m.sseClient.ResetRetry()
			return m, tea.Batch(m.healthPollTick(), m.startSSE())
		}
		return m, m.healthPollTick()

	case sseSnapshotMsg:
		m.lastServerActivity = time.Now()
		return m.handleSnapshot(msg.Events)

	case sseAppendMsg:
		m.lastServerActivity = time.Now()
		return m.handleAppend(msg.Event)

	case sseUpdateMsg:
		m.lastServerActivity = time.Now()
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

	case animStepMsg:
		for _, a := range m.activeAnims {
			if a.id == msg.id {
				cmd := a.animate(msg)
				m.refreshViewport()
				return m, cmd
			}
		}
		return m, nil

	case scrollbarHideMsg:
		if msg.id == m.scrollbarHideID {
			m.scrollbarVisible = false
		}
		return m, nil

	case copyChatSelectionMsg:
		if msg.clickID == m.sel.pendingClickID && m.sel.hasSelection() {
			startLine, startCol, endLine, endCol := m.sel.orderedRange()
			text := extractSelectedText(m.contentLines, startLine, startCol, endLine, endCol)
			if text != "" {
				m.sel.clear()
				return m, copyToClipboard(text)
			}
		}
		return m, nil
	}

	return m, tea.Batch(cmds...)
}

func (m Model) View() tea.View {
	if !m.ready {
		v := tea.NewView("Initializing...")
		v.AltScreen = true
		return v
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
	m.viewport.SetHeight(vpHeight)
	m.viewport.SetWidth(m.width)

	// Build dialog overlay
	var dialogView string
	if m.dialog != nil {
		dialogView = m.dialog.View(m.width, m.height)
	}

	// Layout
	var b strings.Builder
	b.WriteString(statusLine)
	b.WriteString("\n")

	vpView := m.viewport.View()
	if m.sel.hasSelection() {
		startLine, startCol, endLine, endCol := m.sel.orderedRange()
		vpView = applyHighlight(vpView, startLine, startCol, endLine, endCol, m.viewport.YOffset(), vpHeight)
	}
	if m.scrollbarVisible {
		vpView = renderScrollbar(vpView, m.viewport.TotalLineCount(), vpHeight, m.viewport.ScrollPercent())
	}
	b.WriteString(vpView)

	b.WriteString("\n")
	b.WriteString(m.renderInput())
	if footer != "" {
		b.WriteString("\n")
		b.WriteString(footer)
	}

	content := b.String()

	// Overlay dialog centered on screen
	if dialogView != "" {
		content = overlayCenter(content, dialogView, m.width, m.height)
	}

	v := tea.NewView(content)
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	return v
}

// ─── Editor handling ──────────────────────────────────────────────

func (m Model) updateEditor(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Editor.Send):
		return m.handleSend()

	case key.Matches(msg, m.keys.Editor.Newline):
		m.textarea.InsertString("\n")
		m.adjustTextareaHeight()
		m.updateGhost()
		return m, nil

	case key.Matches(msg, m.keys.Editor.FocusChat):
		// Accept ghost suggestion if present, otherwise switch focus.
		if m.ghostSuggestion != "" {
			m.textarea.InsertString(m.ghostSuggestion)
			m.ghostSuggestion = ""
			return m, nil
		}
		m.focus = focusChat
		m.textarea.Blur()
		return m, nil

	case key.Matches(msg, m.keys.Editor.HistoryPrev):
		// Enter attachment selection if we have attachments and input is empty/at start
		if len(m.attachments) > 0 && (m.textarea.Value() == "" || isAtEditorStart(m.textarea)) {
			m.focus = focusAttachments
			m.attachmentCursor = len(m.attachments) - 1
			m.textarea.Blur()
			return m, nil
		}
		return m.handleHistoryUp(msg)

	case key.Matches(msg, m.keys.Editor.HistoryNext):
		return m.handleHistoryDown(msg)
	}

	// Backspace on empty input removes last attachment
	if key.Matches(msg, m.keys.Attachments.Remove) && m.textarea.Value() == "" && len(m.attachments) > 0 {
		m.attachments = m.attachments[:len(m.attachments)-1]
		m.resizeComponents()
		return m, nil
	}

	// Pass to textarea
	oldVal := m.textarea.Value()
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)

	// Track draft changes for history
	if m.textarea.Value() != oldVal {
		m.history.UpdateDraft(m.textarea.Value())
		m.adjustTextareaHeight()
	}

	m.updateGhost()
	return m, cmd
}

func (m Model) handleSend() (tea.Model, tea.Cmd) {
	value := m.textarea.Value()

	// Backslash escape: if the line ends with \, remove it and insert a
	// newline instead of sending. This mirrors Crush's pattern.
	if before, found := strings.CutSuffix(value, "\\"); found {
		m.textarea.SetValue(before + "\n")
		return m, nil
	}

	text := strings.TrimSpace(value)
	hasAttachments := len(m.attachments) > 0

	// Nothing to send
	if text == "" && !hasAttachments {
		return m, nil
	}

	// Check for slash command (only when no attachments)
	if !hasAttachments {
		if cmd := matchSlashCommand(text); cmd != nil {
			m.textarea.Reset()
			m.history.Reset()
			m.ghostSuggestion = ""
			return m.executeCommand(cmd)
		}
	}

	// Cannot send if not connected
	if m.connState != StateConnected {
		return m, nil
	}

	// Save to history and clear
	if text != "" {
		m.history.Add(text)
	}
	m.textarea.Reset()
	m.textarea.SetHeight(1)

	// Grab attachments and clear them
	pendingFiles := m.attachments
	m.attachments = nil
	m.attachmentCursor = 0
	m.focus = focusEditor
	m.textarea.Focus()

	m.resizeComponents()
	m.autoScroll = true

	return m, m.sendMessage(text, pendingFiles...)
}

// handleHistoryUp navigates up in prompt history.
// Ported from Crush history.go — boundary-aware.
func (m Model) handleHistoryUp(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
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
func (m Model) handleHistoryDown(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
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

// ─── Attachment selection handling ─────────────────────────────────

func (m Model) updateAttachments(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Attachments.Right):
		if m.attachmentCursor < len(m.attachments)-1 {
			m.attachmentCursor++
		}
		return m, nil

	case key.Matches(msg, m.keys.Attachments.Left):
		if m.attachmentCursor > 0 {
			m.attachmentCursor--
		}
		return m, nil

	case key.Matches(msg, m.keys.Attachments.Remove):
		if len(m.attachments) > 0 {
			m.attachments = append(m.attachments[:m.attachmentCursor], m.attachments[m.attachmentCursor+1:]...)
			if len(m.attachments) == 0 {
				// No attachments left — return to editor
				m.attachmentCursor = 0
				m.focus = focusEditor
				m.textarea.Focus()
			} else if m.attachmentCursor >= len(m.attachments) {
				// Clamp cursor to last item
				m.attachmentCursor = len(m.attachments) - 1
			}
			m.resizeComponents()
		}
		return m, nil

	case key.Matches(msg, m.keys.Attachments.Cancel):
		m.focus = focusEditor
		m.textarea.Focus()
		return m, nil
	}
	return m, nil
}

// ─── Chat viewport handling ───────────────────────────────────────

func (m Model) updateChat(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// Tab back to editor
	if key.Matches(msg, m.keys.Chat.FocusEditor) {
		m.focus = focusEditor
		m.textarea.Focus()
		return m, nil
	}

	switch {
	case key.Matches(msg, m.keys.Chat.Up):
		m.viewport.ScrollUp(1)
	case key.Matches(msg, m.keys.Chat.Down):
		m.viewport.ScrollDown(1)
	case key.Matches(msg, m.keys.Chat.PageUp):
		m.viewport.HalfPageUp()
	case key.Matches(msg, m.keys.Chat.PageDown):
		m.viewport.HalfPageDown()
	case key.Matches(msg, m.keys.Chat.Home):
		m.viewport.GotoTop()
	case key.Matches(msg, m.keys.Chat.End):
		m.viewport.GotoBottom()
	default:
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		m.autoScroll = m.viewport.AtBottom()
		return m, tea.Batch(cmd, m.showScrollbar())
	}

	m.autoScroll = m.viewport.AtBottom()
	return m, m.showScrollbar()
}

// ─── Dialog handling ──────────────────────────────────────────────

func (m Model) updateDialog(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// Capture reference to current dialog before Update may nil it.
	prev := m.dialog
	newDialog, action := prev.Update(msg, m.keys)
	m.dialog = newDialog

	switch action {
	case ActionClose:
		m.dialog = nil
		return m, nil

	case ActionClearSession:
		m.dialog = nil
		return m, m.clearSession()

	case ActionSelectCommand:
		// prev still points to the CommandPaletteDialog even if Update returned nil.
		if cp, ok := prev.(*CommandPaletteDialog); ok {
			if sel := cp.Selected(); sel != nil {
				m.dialog = nil
				return m.executeCommand(sel)
			}
		}
		m.dialog = nil
		return m, nil

	case ActionRetry:
		m.sseClient.ResetRetry()
		return m, m.startSSE()
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
		// Start thinking animation.
		a := newChatAnim("Thinking")
		m.activeAnims[m.thinkingAnimID] = a
		m.refreshViewport()
		return m, a.start()
	} else if IsAgentEnd(ev.Type) {
		m.isAgentRunning = false
		delete(m.activeAnims, m.thinkingAnimID)
	}

	// assistant_message append: create streaming placeholder
	if ev.Type == "assistant_message" {
		// Stop thinking anim once content starts arriving.
		delete(m.activeAnims, m.thinkingAnimID)

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

	// Start animation for new tool calls.
	var animCmd tea.Cmd
	if ev.Type == "tool_execution" {
		for _, part := range stored.Parts {
			if part.Type == PartToolCall && part.ToolCallID != "" {
				label := part.Name
				if label == "" {
					label = "Running"
				}
				a := newChatAnim(label)
				m.activeAnims[part.ToolCallID] = a
				animCmd = a.start()
			}
		}
	}

	m.messages = append(m.messages, stored)
	m.refreshViewport()
	if animCmd != nil {
		return m, animCmd
	}
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
		// Stop animation for completed tool calls.
		for _, part := range stored.Parts {
			if part.ToolCallID == "" {
				continue
			}
			// Completed: either a PartToolResult or a PartToolCall with embedded result.
			if part.Type == PartToolResult || (part.Type == PartToolCall && (part.Result != "" || part.ElapsedMs > 0)) {
				delete(m.activeAnims, part.ToolCallID)
			}
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
	case "theme":
		return m.toggleTheme()
	default:
		return m, nil
	}
}

func (m Model) toggleTheme() (tea.Model, tea.Cmd) {
	ToggleTheme()
	m.msgRenderCache = make(map[string]string)
	m.msgRenderCacheWidth = 0
	m.refreshViewport()
	// Emit OSC 11 to signal terminal background color change.
	// Use tea.Raw to route through BubbleTea's output pipeline.
	osc11 := fmt.Sprintf("\x1b]11;%s\x07", ThemeBgHex())
	return m, tea.Raw(osc11)
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

func (m Model) sendMessage(text string, files ...PendingAttachment) tea.Cmd {
	httpClient := m.httpClient
	sessionID := m.sessionID
	return func() tea.Msg {
		ctx := context.Background()

		// Upload files via TUS
		var results []AttachmentResult
		for _, f := range files {
			r, err := httpClient.UploadFile(ctx, f.FilePath)
			if err != nil {
				return sendDoneMsg{err: fmt.Errorf("upload %s: %w", f.Name, err)}
			}
			results = append(results, r)
		}

		err := httpClient.SendMessage(ctx, sessionID, text, results)
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
	// Snapshot the slice so the closure doesn't race with SSE mutations.
	eventsSnapshot := make([]EventRow, len(m.allEvents))
	copy(eventsSnapshot, m.allEvents)
	return func() tea.Msg {
		session, err := m.httpClient.GetCurrentSession(context.Background())
		if err != nil {
			return sessionInfoLoadedMsg{session: nil}
		}
		stats := ComputeStatsFromEvents(eventsSnapshot)
		return sessionInfoLoadedMsg{session: session, stats: stats}
	}
}

func (m Model) saveTranscript() tea.Cmd {
	// Include in-flight streaming message if present.
	msgs := make([]StoredMessage, len(m.messages))
	copy(msgs, m.messages)
	if m.streamingMsg != nil {
		msgs = append(msgs, *m.streamingMsg)
	}
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
	inputH := lipgloss.Height(m.renderInput())
	vpHeight := m.height - statusH - footerH - inputH
	if vpHeight < 1 {
		vpHeight = 1
	}
	m.viewport.SetWidth(m.width)
	m.viewport.SetHeight(vpHeight)
	m.refreshViewport()
}

func (m *Model) refreshViewport() {
	content := renderMessages(m, m.width)
	m.contentLines = strings.Split(content, "\n")
	m.viewport.SetContent(content)
	if m.autoScroll {
		m.viewport.GotoBottom()
	}
}

const maxTextareaHeight = 6

// adjustTextareaHeight grows/shrinks the textarea to fit content, capped at maxTextareaHeight.
func (m *Model) adjustTextareaHeight() {
	lines := m.textarea.LineCount()
	if lines < 1 {
		lines = 1
	}
	if lines > maxTextareaHeight {
		lines = maxTextareaHeight
	}
	m.textarea.SetHeight(lines)
	m.resizeComponents()
}

func (m Model) renderInput() string {
	style := inputBorder
	if m.focus == focusEditor || m.focus == focusAttachments {
		style = inputBorderFocused
	}

	// Content width inside the border (border=1 + padding=1 on each side = -4)
	contentWidth := m.width - 4 - 2 // extra -2 for border padding

	var parts []string

	// Attachment bar (above textarea)
	if len(m.attachments) > 0 {
		bar := renderAttachmentBar(m.attachments, m.attachmentCursor, m.focus == focusAttachments, contentWidth)
		parts = append(parts, bar)
	}

	// Textarea
	view := m.textarea.View()
	if m.ghostSuggestion != "" && m.focus == focusEditor {
		// The textarea pads each line with spaces to its full width.
		// Trim trailing spaces from the first line so the ghost text
		// appears right after the cursor instead of wrapping to the next line.
		ghost := dimStyle.Render(m.ghostSuggestion)
		if idx := strings.Index(view, "\n"); idx >= 0 {
			firstLine := strings.TrimRight(view[:idx], " ")
			view = firstLine + ghost + view[idx:]
		} else {
			view = strings.TrimRight(view, " ") + ghost
		}
	}
	parts = append(parts, view)

	return style.Width(m.width - 4).Render(strings.Join(parts, "\n"))
}

// updateGhost computes inline autocomplete for slash commands.
func (m *Model) updateGhost() {
	m.ghostSuggestion = ""
	text := m.textarea.Value()
	if !strings.HasPrefix(text, "/") || strings.Contains(text, " ") {
		return
	}
	prefix := text[1:] // strip leading /
	for _, cmd := range Commands {
		if strings.HasPrefix(cmd.Name, prefix) && cmd.Name != prefix {
			m.ghostSuggestion = cmd.Name[len(prefix):]
			return
		}
	}
}

func (m *Model) cleanup() {
	m.sseClient.Disconnect()
	if m.sseCancel != nil {
		m.sseCancel()
	}
}

// showScrollbar makes the scrollbar visible and schedules an auto-hide.
func (m *Model) showScrollbar() tea.Cmd {
	m.scrollbarVisible = true
	m.scrollbarHideID++
	id := m.scrollbarHideID
	return tea.Tick(scrollbarHideDelay, func(_ time.Time) tea.Msg {
		return scrollbarHideMsg{id: id}
	})
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

// ─── Mouse handling ───────────────────────────────────────────────

// paneRect describes a rectangular region in terminal cells.
type paneRect struct {
	minY, maxY int // inclusive row range
}

// paneLayout holds the computed Y-ranges for each pane.
type paneLayout struct {
	status paneRect
	chat   paneRect
	input  paneRect
	footer paneRect
}

// computeLayout returns pane rectangles matching the View() rendering order.
func (m *Model) computeLayout() paneLayout {
	statusH := 1
	footerH := 1
	inputH := lipgloss.Height(m.renderInput())
	vpHeight := m.height - statusH - footerH - inputH
	if vpHeight < 1 {
		vpHeight = 1
	}

	y := 0
	status := paneRect{minY: y, maxY: y + statusH - 1}
	y += statusH

	chat := paneRect{minY: y, maxY: y + vpHeight - 1}
	y += vpHeight

	input := paneRect{minY: y, maxY: y + inputH - 1}
	y += inputH

	footer := paneRect{minY: y, maxY: y + footerH - 1}

	return paneLayout{status: status, chat: chat, input: input, footer: footer}
}

// pointInPane returns true if the Y coordinate is within the pane.
func pointInPane(y int, r paneRect) bool {
	return y >= r.minY && y <= r.maxY
}

// handleMouseMsg processes mouse events for pane focus switching, wheel
// routing, and text selection in the chat pane.
func (m Model) handleMouseMsg(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	// Ignore mouse when a dialog is open (keyboard-only scope).
	if m.dialog != nil {
		return m, nil
	}

	layout := m.computeLayout()

	switch msg := msg.(type) {
	case tea.MouseClickMsg:
		mouse := msg.Mouse()
		if mouse.Button == tea.MouseLeft {
			// Click in input pane: clear selection, switch focus.
			if pointInPane(mouse.Y, layout.input) {
				m.sel.clear()
				if m.focus != focusEditor {
					m.focus = focusEditor
					m.textarea.Focus()
				}
				return m, nil
			}

			// Click in chat pane: focus + selection handling.
			if pointInPane(mouse.Y, layout.chat) {
				if m.focus != focusChat {
					m.focus = focusChat
					m.textarea.Blur()
				}

				m.sel.pendingClickID++
				m.sel.detectMultiClick(mouse.X, mouse.Y)

				contentLine := (mouse.Y - layout.chat.minY) + m.viewport.YOffset()
				contentCol := mouse.X

				switch m.sel.clickCount {
				case 1:
					m.sel.mouseDown = true
					m.sel.anchorLine = contentLine
					m.sel.anchorCol = contentCol
					m.sel.headLine = contentLine
					m.sel.headCol = contentCol
				case 2:
					m.sel.selectWord(m.contentLines, contentLine, contentCol)
				case 3:
					m.sel.selectLine(m.contentLines, contentLine)
					m.sel.clickCount = 0
				}
				return m, nil
			}

			// Click elsewhere: clear selection.
			m.sel.clear()
		}

	case tea.MouseMotionMsg:
		mouse := msg.Mouse()
		if !m.sel.mouseDown {
			return m, nil
		}

		contentLine := (mouse.Y - layout.chat.minY) + m.viewport.YOffset()
		contentCol := mouse.X

		// Auto-scroll at chat pane edges.
		var scrolled bool
		visY := mouse.Y - layout.chat.minY
		chatHeight := layout.chat.maxY - layout.chat.minY
		if visY <= 0 {
			m.viewport.ScrollUp(1)
			contentLine = m.viewport.YOffset()
			scrolled = true
		} else if visY >= chatHeight {
			m.viewport.ScrollDown(1)
			contentLine = m.viewport.YOffset() + chatHeight
			scrolled = true
		}

		// Clamp contentLine to valid range.
		if contentLine < 0 {
			contentLine = 0
		}
		if contentLine >= len(m.contentLines) {
			contentLine = len(m.contentLines) - 1
		}

		m.sel.headLine = contentLine
		m.sel.headCol = contentCol
		m.autoScroll = m.viewport.AtBottom()
		if scrolled {
			return m, m.showScrollbar()
		}
		return m, nil

	case tea.MouseReleaseMsg:
		if m.sel.mouseDown {
			m.sel.mouseDown = false
			if m.sel.hasSelection() {
				clickID := m.sel.pendingClickID
				return m, tea.Tick(doubleClickThreshold, func(_ time.Time) tea.Msg {
					return copyChatSelectionMsg{clickID: clickID}
				})
			}
		}
		return m, nil

	case tea.MouseWheelMsg:
		mouse := msg.Mouse()
		if !pointInPane(mouse.Y, layout.chat) {
			return m, nil
		}
		isHorizontal := mouse.Button == tea.MouseWheelLeft || mouse.Button == tea.MouseWheelRight
		if isHorizontal {
			// Suppress horizontal scroll if a vertical scroll happened recently
			// (diagonal trackpad swipe). Pure horizontal gestures pass through.
			if time.Since(m.lastVerticalWheel) < 200*time.Millisecond {
				return m, nil
			}
		} else {
			m.lastVerticalWheel = time.Now()
		}
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		m.autoScroll = m.viewport.AtBottom()
		return m, tea.Batch(cmd, m.showScrollbar())
	}

	return m, nil
}

// ─── Editor boundary checks (ported from Crush) ──────────────────

func isAtEditorStart(ta textarea.Model) bool {
	// Only trigger history when cursor is on the first line at column 0.
	li := ta.LineInfo()
	return ta.Line() == 0 && li.ColumnOffset == 0
}

func isAtEditorEnd(ta textarea.Model) bool {
	// Only trigger history when cursor is on the last line at the end.
	if ta.Line() < ta.LineCount()-1 {
		return false
	}
	li := ta.LineInfo()
	return li.ColumnOffset >= li.CharWidth
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
		// ANSI-aware truncation so we don't cut through escape sequences.
		prefix := ansi.Truncate(bgLine, startX, "")
		bgLines[y] = prefix + fgLine
	}

	return strings.Join(bgLines, "\n")
}
