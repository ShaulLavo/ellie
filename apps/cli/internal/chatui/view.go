package chatui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

// Styles for the chat TUI — rebuilt by rebuildViewStyles() on theme change.
var (
	statusLineStyle        lipgloss.Style
	connectedStyle         lipgloss.Style
	connectingStyle        lipgloss.Style
	errorStyle             lipgloss.Style
	disconnectedStyle      lipgloss.Style
	userStyle              lipgloss.Style
	agentStyle             lipgloss.Style
	memoryStyle            lipgloss.Style
	systemStyle            lipgloss.Style
	toolCallStyle          lipgloss.Style
	toolResultStyle        lipgloss.Style
	thinkingStyle          lipgloss.Style
	dimStyle               lipgloss.Style
	inputBorder            lipgloss.Style
	inputBorderFocused     lipgloss.Style
	footerStyle            lipgloss.Style
	attachmentStyle        lipgloss.Style
	attachmentSelectedStyle lipgloss.Style
	attachmentHintStyle    lipgloss.Style
)

func rebuildViewStyles() {
	statusLineStyle = lipgloss.NewStyle().
		Foreground(colorDim).
		Padding(0, 1)

	connectedStyle = lipgloss.NewStyle().Foreground(colorDim)
	connectingStyle = lipgloss.NewStyle().Foreground(colorDim)
	errorStyle = lipgloss.NewStyle().Foreground(colorDim)
	disconnectedStyle = lipgloss.NewStyle().Foreground(colorDim)

	userStyle = lipgloss.NewStyle().
		Foreground(colorUser).
		Bold(true)
	agentStyle = lipgloss.NewStyle().
		Foreground(colorAccent).
		Bold(true)
	memoryStyle = lipgloss.NewStyle().
		Foreground(colorMemory).
		Bold(true)
	systemStyle = lipgloss.NewStyle().
		Foreground(colorSystem).
		Bold(true)

	toolCallStyle = lipgloss.NewStyle().
		Foreground(colorMuted)
	toolResultStyle = lipgloss.NewStyle().
		Foreground(colorDim)
	thinkingStyle = lipgloss.NewStyle().
		Foreground(colorMuted).
		Italic(true)
	dimStyle = lipgloss.NewStyle().
		Foreground(colorDim)

	inputBorder = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorSurface).
		Padding(0, 1)
	inputBorderFocused = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorAccent).
		Padding(0, 1)

	footerStyle = lipgloss.NewStyle().
		Foreground(colorMuted)

	attachmentStyle = lipgloss.NewStyle().
		Foreground(colorMuted)
	attachmentSelectedStyle = lipgloss.NewStyle().
		Foreground(colorAccent).
		Bold(true)
	attachmentHintStyle = lipgloss.NewStyle().
		Foreground(colorDim)
}

// renderStatusLine renders the top status bar.
func renderStatusLine(m *Model, width int) string {
	var connIndicator string
	switch m.connState {
	case StateConnected:
		connIndicator = connectedStyle.Render("● connected")
	case StateConnecting:
		connIndicator = connectingStyle.Render("◌ connecting...")
	case StateError:
		connIndicator = errorStyle.Render("✕ error")
		if m.connError != "" {
			connIndicator += errorStyle.Render(" — " + m.connError)
		}
	default:
		connIndicator = disconnectedStyle.Render("○ disconnected")
	}

	branchInfo := dimStyle.Render(fmt.Sprintf("branch: %s", truncateID(m.branchID)))

	left := connIndicator
	right := branchInfo
	padding := width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if padding < 1 {
		padding = 1
	}

	return statusLineStyle.Width(width).Render(
		left + strings.Repeat(" ", padding) + right,
	)
}

// renderMessages renders the chat viewport content.
// audioPlayingID is threaded through for audio play/stop indication.
func renderMessages(m *Model, width int) string {
	contentWidth := width - 2

	// Invalidate cache on width change.
	if m.msgRenderCacheWidth != contentWidth {
		m.msgRenderCache = make(map[string]string)
		m.msgRenderCacheWidth = contentWidth
	}

	tg := ComputeToolGrouping(m.messages, m.streamingMsg)

	var b strings.Builder

	// Track active runId to group consecutive messages from the same run
	// under a single sender label (mirrors FE assistant-turn grouping).
	activeRunID := ""

	for _, msg := range m.messages {
		if tg.HiddenMessageIDs[msg.ID] {
			continue
		}

		// Determine whether this message starts a new group or continues the current run.
		showSender := true
		if msg.RunID != "" && msg.RunID == activeRunID {
			showSender = false
		}
		if msg.RunID != "" {
			activeRunID = msg.RunID
		} else {
			activeRunID = ""
		}

		// Check if this message has any active animations or playing audio (skip cache if so).
		hasActiveAnim := messageHasActiveAnim(msg, m.activeAnims)
		hasAudioState := m.audioPlayingID != "" && messageHasAudio(msg)
		// Cache key includes showSender state since the same message renders differently
		// depending on whether it's the first in a run group.
		cacheKey := msg.ID
		if !showSender {
			cacheKey += ":nosender"
		}
		// Use cached render for non-streaming, finalized messages without active anims.
		if !msg.IsStreaming && !hasActiveAnim && !hasAudioState {
			if cached, ok := m.msgRenderCache[cacheKey]; ok {
				b.WriteString(cached)
				b.WriteString("\n")
				continue
			}
		}
		rendered := renderMessage(msg, tg, contentWidth, m.activeAnims, m.audioPlayingID, showSender)
		if !msg.IsStreaming && !hasActiveAnim {
			m.msgRenderCache[cacheKey] = rendered
		}
		b.WriteString(rendered)
		b.WriteString("\n")
	}

	// Render streaming message (never cached).
	if m.streamingMsg != nil {
		streamShowSender := true
		if m.streamingMsg.RunID != "" && m.streamingMsg.RunID == activeRunID {
			streamShowSender = false
		}
		b.WriteString(renderMessage(*m.streamingMsg, tg, contentWidth, m.activeAnims, m.audioPlayingID, streamShowSender))
		b.WriteString("\n")
	}

	return b.String()
}

// renderMessage renders a single chat message.
// showSender controls whether the sender label is displayed; when messages
// share the same runId they are grouped under a single label (like the web FE).
func renderMessage(msg StoredMessage, tg ToolGrouping, width int, anims map[string]*chatAnim, audioPlayingID string, showSender bool) string {
	// Checkpoint messages render as standalone dividers without a sender label.
	if len(msg.Parts) == 1 && msg.Parts[0].Type == PartCheckpoint {
		return renderPart(msg.Parts[0], tg, width, anims, audioPlayingID)
	}

	var b strings.Builder

	// Sender label — only shown for the first message in a run group.
	if showSender {
		label := renderSenderLabel(msg.Sender)
		b.WriteString(label)
		b.WriteString("\n")
	}

	// Thinking (collapsed by default, show indicator)
	if msg.Thinking != "" {
		lines := strings.Count(msg.Thinking, "\n") + 1
		b.WriteString(thinkingStyle.Render(fmt.Sprintf("  ◇ thinking (%d lines)", lines)))
		b.WriteString("\n")
	}

	// Content parts
	for _, part := range msg.Parts {
		rendered := renderPart(part, tg, width, anims, audioPlayingID)
		if rendered != "" {
			b.WriteString(rendered)
			b.WriteString("\n")
		}
	}

	// Streaming indicator: use thinking animation if available, otherwise static cursor.
	if msg.IsStreaming && msg.Text == "" && len(msg.Parts) == 0 {
		if a, ok := anims["_thinking"]; ok {
			b.WriteString("  " + a.render())
		} else {
			b.WriteString(thinkingStyle.Render("  ▍"))
		}
		b.WriteString("\n")
	}

	return b.String()
}

func renderSenderLabel(sender MessageSender) string {
	label := string(sender)
	switch sender {
	case SenderUser, SenderHuman:
		return userStyle.Render(label)
	case SenderAgent:
		return agentStyle.Render(label)
	case SenderMemory:
		return memoryStyle.Render(label)
	case SenderSystem:
		return systemStyle.Render(label)
	default:
		return userStyle.Render(label)
	}
}

func renderPart(part ContentPart, tg ToolGrouping, width int, anims map[string]*chatAnim, audioPlayingID string) string {
	switch part.Type {
	case PartText:
		w := width
		if w > maxMessageWidth {
			w = maxMessageWidth
		}
		return renderMarkdown(part.Text, w)

	case PartToolCall:
		// Skip streaming tool-calls superseded by a real execution
		if part.Streaming && tg.ConsumedToolCallIDs[part.ToolCallID] {
			return ""
		}
		resultLine := ""
		animLine := ""
		elapsed := ""
		if part.Result != "" || part.ElapsedMs > 0 {
			// Completed tool call with embedded result.
			if part.ElapsedMs > 0 {
				elapsed = " " + dimStyle.Render(formatElapsed(part.ElapsedMs))
			}
			if part.Result != "" {
				truncated := part.Result
				if len(truncated) > 200 {
					truncated = truncated[:200] + "..."
				}
				resultLine = "\n" + toolResultStyle.Render("  → "+truncated)
			}
		} else if result, ok := tg.ToolResults[part.ToolCallID]; ok {
			// Completed via ToolGrouping (result in a separate message).
			if result.ElapsedMs > 0 {
				elapsed = " " + dimStyle.Render(formatElapsed(result.ElapsedMs))
			}
			if result.Result != "" {
				truncated := result.Result
				if len(truncated) > 200 {
					truncated = truncated[:200] + "..."
				}
				resultLine = "\n" + toolResultStyle.Render("  → "+truncated)
			}
		} else if a, ok := anims[part.ToolCallID]; ok {
			// Active tool call: show spinner.
			animLine = "\n  " + a.render()
		}
		header := toolCallStyle.Render(fmt.Sprintf("  ⚙ %s", part.Name)) + elapsed
		return header + animLine + resultLine

	case PartToolResult:
		// Standalone tool results (not consumed inline)
		if part.ToolCallID != "" && tg.ConsumedToolCallIDs[part.ToolCallID] {
			return "" // Hidden — already shown inline with tool-call
		}
		name := part.ToolName
		if name == "" {
			name = "tool"
		}
		truncated := part.Result
		if len(truncated) > 300 {
			truncated = truncated[:300] + "..."
		}
		return toolResultStyle.Render(fmt.Sprintf("  ← %s: %s", name, truncated))

	case PartMemory:
		var lines []string
		header := memoryStyle.Render("  ◆ Memory Recall")
		if part.DurationMs > 0 {
			header += " " + dimStyle.Render(formatElapsed(part.DurationMs))
		}
		lines = append(lines, header)
		if len(part.Memories) > 0 {
			for _, m := range part.Memories {
				lines = append(lines, dimStyle.Render("    - "+m.Text))
			}
		} else if part.Text != "" {
			lines = append(lines, dimStyle.Render("    "+part.Text))
		}
		if part.Count > 0 {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("    (%d memories)", part.Count)))
		}
		return strings.Join(lines, "\n")

	case PartMemoryRetain:
		var lines []string
		header := memoryStyle.Render(fmt.Sprintf("  ◇ Memory Retain (%d facts)", part.FactsStored))
		if part.DurationMs > 0 {
			header += " " + dimStyle.Render(formatElapsed(part.DurationMs))
		}
		lines = append(lines, header)
		for _, f := range part.Facts {
			lines = append(lines, dimStyle.Render("    - "+f))
		}
		return strings.Join(lines, "\n")

	case PartArtifact:
		title := part.Title
		if title == "" {
			title = part.Filename
		}
		return dimStyle.Render(fmt.Sprintf("  📎 Artifact: %s (%s)", title, part.ArtifactType))

	case PartCheckpoint:
		msg := part.Message
		if msg == "" {
			msg = "New day, new thread"
		}
		label := "  ☀ " + msg + " "
		lineLen := width - lipgloss.Width(label)
		if lineLen < 2 {
			lineLen = 2
		}
		return dimStyle.Render(label + strings.Repeat("─", lineLen))

	case PartAudio:
		label := "Voice message"
		if part.SynthesizedText != "" {
			// Show a short preview of the synthesized text.
			preview := part.SynthesizedText
			if len(preview) > 60 {
				preview = preview[:60] + "..."
			}
			label = preview
		}
		if audioPlayingID != "" && part.UploadID == audioPlayingID {
			return dimStyle.Render("  \u266b ") + dimStyle.Render(label) + " " + toolCallStyle.Render("["+"\u25a0"+" Stop]")
		}
		return dimStyle.Render("  \u266b ") + dimStyle.Render(label) + " " + toolCallStyle.Render("["+"\u25b6"+" Play]")

	case PartThinking:
		return "" // Already rendered at message level

	default:
		return dimStyle.Render(fmt.Sprintf("  [%s]", part.Type))
	}
}

// renderFooter renders the bottom stats line.
func renderFooter(m *Model, width int) string {
	var parts []string

	if m.stats.Model != nil {
		parts = append(parts, formatModelName(*m.stats.Model))
	}
	if m.stats.Provider != nil {
		parts = append(parts, *m.stats.Provider)
	}
	if m.stats.PromptTokens > 0 || m.stats.CompletionTokens > 0 {
		parts = append(parts, fmt.Sprintf("↑%d ↓%d tok",
			m.stats.PromptTokens, m.stats.CompletionTokens))
	}
	if m.stats.TotalCost > 0 {
		parts = append(parts, fmt.Sprintf("$%.4f", m.stats.TotalCost))
	}
	if m.stats.MessageCount > 0 {
		parts = append(parts, fmt.Sprintf("%d msgs", m.stats.MessageCount))
	}
	if m.isAgentRunning {
		parts = append(parts, connectingStyle.Render("● thinking"))
	}

	if len(parts) == 0 {
		return ""
	}

	return footerStyle.Width(width).Render(
		"  " + strings.Join(parts, "  │  "),
	)
}

// renderAttachmentBar renders the attachment pills above the textarea.
// In normal mode it shows pills with a "↑ to select" hint.
// In selection mode it highlights the selected pill and shows navigation hints.
func renderAttachmentBar(attachments []PendingAttachment, cursor int, selected bool, width int) string {
	if len(attachments) == 0 {
		return ""
	}

	// Build sequential numbering per label category
	labelCounts := make(map[string]int)
	type pill struct {
		label string
		num   int
	}
	pills := make([]pill, len(attachments))
	for i, a := range attachments {
		lbl := attachmentPillLabel(a)
		labelCounts[lbl]++
		pills[i] = pill{label: lbl, num: labelCounts[lbl]}
	}

	var b strings.Builder
	for i, p := range pills {
		text := fmt.Sprintf("[%s #%d]", p.label, p.num)
		if selected && i == cursor {
			b.WriteString(attachmentSelectedStyle.Render(text))
		} else {
			b.WriteString(attachmentStyle.Render(text))
		}
		if i < len(pills)-1 {
			b.WriteString(" ")
		}
	}

	// Add hint text
	if selected {
		hint := "→ to next ← to prev · Delete to remove · Esc to cancel"
		// Only add hint if it fits
		pillsWidth := lipgloss.Width(b.String())
		remaining := width - pillsWidth - 2
		if remaining > 10 {
			b.WriteString("  ")
			b.WriteString(attachmentHintStyle.Render(hint))
		}
	} else {
		hint := "(↑ to select)"
		pillsWidth := lipgloss.Width(b.String())
		remaining := width - pillsWidth - 2
		if remaining >= lipgloss.Width(hint) {
			b.WriteString("  ")
			b.WriteString(attachmentHintStyle.Render(hint))
		}
	}

	return b.String()
}

// formatModelName strips common prefixes/suffixes for display.
// Mirrors FE branch-status-bar.tsx behavior.
func formatModelName(model string) string {
	s := model
	s = strings.TrimPrefix(s, "claude-")
	// Remove date suffix like -20240229
	if len(s) > 9 && s[len(s)-9] == '-' {
		// Check if last 8 chars are all digits
		suffix := s[len(s)-8:]
		allDigits := true
		for _, c := range suffix {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			s = s[:len(s)-9]
		}
	}
	return s
}

// formatElapsed formats a duration in milliseconds for display.
// Matches the FE formatElapsed: "234ms" or "1.2s".
func formatElapsed(ms int) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

// wrapText performs simple word wrapping, preserving leading indentation.
func wrapText(text string, width int) string {
	if width <= 0 || len(text) <= width {
		return text
	}

	var result strings.Builder
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if i > 0 {
			result.WriteString("\n")
		}
		if len(line) <= width {
			result.WriteString(line)
			continue
		}

		// Measure leading whitespace to preserve indentation on wrapped lines.
		indent := ""
		for _, r := range line {
			if r == ' ' || r == '\t' {
				indent += string(r)
			} else {
				break
			}
		}

		// Split by spaces while preserving spacing (use SplitAfter to keep delimiters).
		words := splitWords(line)
		currentLine := ""
		for _, word := range words {
			if currentLine == "" {
				currentLine = word
			} else if len(currentLine)+len(word) <= width {
				currentLine += word
			} else {
				result.WriteString(currentLine + "\n")
				currentLine = indent + strings.TrimLeft(word, " ")
			}
		}
		if currentLine != "" {
			result.WriteString(currentLine)
		}
	}
	return result.String()
}

// messageHasAudio returns true if any part in the message is an audio part.
func messageHasAudio(msg StoredMessage) bool {
	for _, part := range msg.Parts {
		if part.Type == PartAudio {
			return true
		}
	}
	return false
}

// messageHasActiveAnim returns true if any tool call in the message has an active animation.
func messageHasActiveAnim(msg StoredMessage, anims map[string]*chatAnim) bool {
	for _, part := range msg.Parts {
		if part.Type == PartToolCall && part.ToolCallID != "" {
			if _, ok := anims[part.ToolCallID]; ok {
				return true
			}
		}
	}
	return false
}

// splitWords splits text into words with trailing spaces attached,
// preserving all whitespace in the original string.
func splitWords(s string) []string {
	var words []string
	current := ""
	inSpace := false
	for _, r := range s {
		isSpace := r == ' '
		if isSpace {
			current += string(r)
			inSpace = true
		} else {
			if inSpace && current != "" {
				words = append(words, current)
				current = ""
			}
			current += string(r)
			inSpace = false
		}
	}
	if current != "" {
		words = append(words, current)
	}
	return words
}
