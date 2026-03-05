package chatui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Styles for the chat TUI.
var (
	statusLineStyle = lipgloss.NewStyle().
			Background(lipgloss.Color("#1a1a2e")).
			Foreground(lipgloss.Color("#e0e0e0")).
			Padding(0, 1)

	connectedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00A66D")).
			Bold(true)
	connectingStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FBBF24"))
	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#EF4444")).
			Bold(true)
	disconnectedStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#666"))

	userStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#60A5FA")).
			Bold(true)
	agentStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00A66D")).
			Bold(true)
	memoryStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A78BFA")).
			Bold(true)
	systemStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#F59E0B")).
			Bold(true)

	toolCallStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888"))
	toolResultStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666"))
	thinkingStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888")).
			Italic(true)
	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666"))

	inputBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#333")).
			Padding(0, 1)
	inputBorderFocused = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color("#00A66D")).
				Padding(0, 1)

	footerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888"))
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

	tg := ComputeToolGrouping(m.messages, m.streamingMsg)

	var b strings.Builder

	for _, msg := range m.messages {
		if tg.HiddenMessageIDs[msg.ID] {
			continue
		}
		b.WriteString(renderMessage(msg, tg, contentWidth))
		b.WriteString("\n")
	}

	// Render streaming message
	if m.streamingMsg != nil {
		b.WriteString(renderMessage(*m.streamingMsg, tg, contentWidth))
		b.WriteString("\n")
	}

	return b.String()
}

// renderMessage renders a single chat message.
func renderMessage(msg StoredMessage, tg ToolGrouping, width int) string {
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
		rendered := renderPart(part, tg, width)
		if rendered != "" {
			b.WriteString(rendered)
			b.WriteString("\n")
		}
	}

	// Streaming indicator
	if msg.IsStreaming && msg.Text == "" && len(msg.Parts) == 0 {
		b.WriteString(thinkingStyle.Render("  ▍"))
		b.WriteString("\n")
	}

	return b.String()
}

func renderSenderLabel(sender MessageSender) string {
	switch sender {
	case SenderUser:
		return userStyle.Render("You")
	case SenderAgent:
		return agentStyle.Render("Ellie")
	case SenderMemory:
		return memoryStyle.Render("Memory")
	case SenderSystem:
		return systemStyle.Render("System")
	default:
		return dimStyle.Render("Unknown")
	}
}

func renderPart(part ContentPart, tg ToolGrouping, width int) string {
	switch part.Type {
	case PartText:
		return wrapText(part.Text, width)

	case PartToolCall:
		status := "running"
		resultLine := ""
		if result, ok := tg.ToolResults[part.ToolCallID]; ok {
			status = "done"
			if result.Result != "" {
				truncated := result.Result
				if len(truncated) > 200 {
					truncated = truncated[:200] + "..."
				}
				resultLine = "\n" + toolResultStyle.Render("  → "+truncated)
			}
		}
		header := toolCallStyle.Render(fmt.Sprintf("  ⚙ %s [%s]", part.Name, status))
		return header + resultLine

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

// wrapText performs simple word wrapping.
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
		// Simple word wrap
		words := strings.Fields(line)
		currentLine := ""
		for _, word := range words {
			if currentLine == "" {
				currentLine = word
			} else if len(currentLine)+1+len(word) <= width {
				currentLine += " " + word
			} else {
				result.WriteString(currentLine + "\n")
				currentLine = word
			}
		}
		if currentLine != "" {
			result.WriteString(currentLine)
		}
	}
	return result.String()
}
