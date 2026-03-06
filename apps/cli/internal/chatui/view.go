package chatui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

// Styles for the chat TUI.
var (
	statusLineStyle = lipgloss.NewStyle().
			Foreground(colorDim).
			Padding(0, 1)

	connectedStyle    = lipgloss.NewStyle().Foreground(colorDim)
	connectingStyle   = lipgloss.NewStyle().Foreground(colorDim)
	errorStyle        = lipgloss.NewStyle().Foreground(colorDim)
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
)

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

	sessionInfo := dimStyle.Render(fmt.Sprintf("session: %s", truncateID(m.sessionID)))

	left := connIndicator
	right := sessionInfo
	padding := width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if padding < 1 {
		padding = 1
	}

	return statusLineStyle.Width(width).Render(
		left + strings.Repeat(" ", padding) + right,
	)
}

// renderMessages renders the chat viewport content.
func renderMessages(m *Model, width int) string {
	contentWidth := width - 2

	// Invalidate cache on width change.
	if m.msgRenderCacheWidth != contentWidth {
		m.msgRenderCache = make(map[string]string)
		m.msgRenderCacheWidth = contentWidth
	}

	tg := ComputeToolGrouping(m.messages, m.streamingMsg)

	var b strings.Builder

	for _, msg := range m.messages {
		if tg.HiddenMessageIDs[msg.ID] {
			continue
		}
		// Check if this message has any active animations (skip cache if so).
		hasActiveAnim := messageHasActiveAnim(msg, m.activeAnims)
		// Use cached render for non-streaming, finalized messages without active anims.
		if !msg.IsStreaming && !hasActiveAnim {
			if cached, ok := m.msgRenderCache[msg.ID]; ok {
				b.WriteString(cached)
				b.WriteString("\n")
				continue
			}
		}
		rendered := renderMessage(msg, tg, contentWidth, m.activeAnims)
		if !msg.IsStreaming && !hasActiveAnim {
			m.msgRenderCache[msg.ID] = rendered
		}
		b.WriteString(rendered)
		b.WriteString("\n")
	}

	// Render streaming message (never cached).
	if m.streamingMsg != nil {
		b.WriteString(renderMessage(*m.streamingMsg, tg, contentWidth, m.activeAnims))
		b.WriteString("\n")
	}

	return b.String()
}

// renderMessage renders a single chat message.
func renderMessage(msg StoredMessage, tg ToolGrouping, width int, anims map[string]*chatAnim) string {
	var b strings.Builder

	// Sender label
	label := renderSenderLabel(msg.Sender)
	b.WriteString(label)
	b.WriteString("\n")

	// Thinking (collapsed by default, show indicator)
	if msg.Thinking != "" {
		lines := strings.Count(msg.Thinking, "\n") + 1
		b.WriteString(thinkingStyle.Render(fmt.Sprintf("  ◇ thinking (%d lines)", lines)))
		b.WriteString("\n")
	}

	// Content parts
	for _, part := range msg.Parts {
		rendered := renderPart(part, tg, width, anims)
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

func renderPart(part ContentPart, tg ToolGrouping, width int, anims map[string]*chatAnim) string {
	switch part.Type {
	case PartText:
		w := width
		if w > maxMessageWidth {
			w = maxMessageWidth
		}
		return renderMarkdown(part.Text, w)

	case PartToolCall:
		resultLine := ""
		animLine := ""
		if result, ok := tg.ToolResults[part.ToolCallID]; ok {
			// Completed tool call.
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
		header := toolCallStyle.Render(fmt.Sprintf("  ⚙ %s", part.Name))
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
		lines = append(lines, memoryStyle.Render("  ◆ Memory Recall"))
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
		lines = append(lines, memoryStyle.Render(fmt.Sprintf("  ◇ Memory Retain (%d facts)", part.FactsStored)))
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

// formatModelName strips common prefixes/suffixes for display.
// Mirrors FE session-status-bar.tsx behavior.
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
