package chatui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// TranscriptEntry mirrors the FE TranscriptEntry.
type TranscriptEntry struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Role      string `json:"role"`
	Type      string `json:"type"`
	Content   string `json:"content"`
}

// Transcript mirrors the FE Transcript.
type Transcript struct {
	GeneratedAt string            `json:"generatedAt"`
	EntryCount  int               `json:"entryCount"`
	Entries     []TranscriptEntry `json:"entries"`
}

// MessagesToTranscript converts StoredMessages to a Transcript,
// matching the FE messagesToTranscript function.
func MessagesToTranscript(messages []StoredMessage) Transcript {
	entries := make([]TranscriptEntry, 0, len(messages))

	for _, msg := range messages {
		role := resolveRoleFromSender(msg.Sender)
		partContent := formatAllParts(msg.Parts)
		thinkingContent := ""
		if msg.Thinking != "" {
			thinkingContent = fmt.Sprintf("<thinking>\n%s\n</thinking>", msg.Thinking)
		}

		var contentPieces []string
		if thinkingContent != "" {
			contentPieces = append(contentPieces, thinkingContent)
		}
		if partContent != "" {
			contentPieces = append(contentPieces, partContent)
		}
		content := strings.Join(contentPieces, "\n")
		if content == "" {
			content = msg.Text
		}

		entryType := resolvePartType(msg.Parts)

		entries = append(entries, TranscriptEntry{
			ID:        msg.ID,
			Timestamp: msg.Timestamp,
			Role:      role,
			Type:      entryType,
			Content:   content,
		})
	}

	return Transcript{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		EntryCount:  len(entries),
		Entries:     entries,
	}
}

// RenderTranscript formats a Transcript as human-readable text,
// matching the FE renderTranscript function.
func RenderTranscript(t Transcript) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Transcript - %d entries\n", t.EntryCount)
	fmt.Fprintf(&b, "Generated: %s\n", t.GeneratedAt)
	b.WriteString(strings.Repeat("=", 60))

	for _, entry := range t.Entries {
		label := "User"
		switch entry.Role {
		case "assistant":
			label = "Assistant"
		case "memory":
			label = "Memory"
		case "system":
			label = "System"
		}
		b.WriteString("\n\n")
		fmt.Fprintf(&b, "[%s] %s (%s)\n", entry.Timestamp, label, entry.Type)
		b.WriteString(strings.Repeat("-", 60))
		b.WriteString("\n")
		b.WriteString(entry.Content)
	}

	b.WriteString("\n\n")
	b.WriteString(strings.Repeat("=", 60))
	b.WriteString("\nEnd of transcript")
	return b.String()
}

// SaveTranscript writes the transcript to a file in the given directory.
// Returns the file path on success.
func SaveTranscript(messages []StoredMessage, sessionID, dir string) (string, error) {
	transcript := MessagesToTranscript(messages)
	text := RenderTranscript(transcript)

	date := time.Now().Format("2006-01-02")
	filename := fmt.Sprintf("transcript-%s-%s.txt", sessionID, date)
	path := filepath.Join(dir, filename)

	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		return "", fmt.Errorf("write transcript: %w", err)
	}
	return path, nil
}

func resolveRoleFromSender(sender MessageSender) string {
	switch sender {
	case SenderHuman, SenderUser:
		return "user"
	case SenderAgent:
		return "assistant"
	case SenderMemory:
		return "memory"
	case SenderSystem:
		return "system"
	default:
		return "user"
	}
}

func formatAllParts(parts []ContentPart) string {
	formatted := make([]string, 0, len(parts))
	for _, p := range parts {
		if s := formatPart(p); s != "" {
			formatted = append(formatted, s)
		}
	}
	return strings.Join(formatted, "\n")
}

func formatPart(part ContentPart) string {
	switch part.Type {
	case PartText:
		return part.Text
	case PartThinking:
		return fmt.Sprintf("<thinking>\n%s\n</thinking>", part.Text)
	case PartToolCall:
		return fmt.Sprintf("[Tool Call: %s]\n%s", part.Name, formatArgs(part.Args))
	case PartToolResult:
		if part.ToolName != "" {
			return fmt.Sprintf("[Tool Result: %s]\n%s", part.ToolName, part.Result)
		}
		return fmt.Sprintf("[Tool Result]\n%s", part.Result)
	case PartMemory:
		if len(part.Memories) > 0 {
			lines := make([]string, len(part.Memories))
			for i, m := range part.Memories {
				lines[i] = "  - " + m.Text
			}
			return fmt.Sprintf("[Memory Recall]\n%s", strings.Join(lines, "\n"))
		}
		return fmt.Sprintf("[Memory Recall]\n%s", part.Text)
	case PartMemoryRetain:
		lines := make([]string, len(part.Facts))
		for i, f := range part.Facts {
			lines[i] = "  - " + f
		}
		return fmt.Sprintf("[Memory Retain - %d facts]\n%s", part.FactsStored, strings.Join(lines, "\n"))
	case PartImage:
		return fmt.Sprintf("[Image: %s]", part.File)
	case PartVideo:
		return fmt.Sprintf("[Video: %s]", part.File)
	case PartAudio:
		return fmt.Sprintf("[Audio: %s]", part.File)
	case PartFile:
		name := part.Filename
		if name == "" {
			name = part.File
		}
		return fmt.Sprintf("[File: %s]", name)
	case PartArtifact:
		title := part.Title
		if title == "" {
			title = part.Filename
		}
		return fmt.Sprintf("[Artifact: %s]\n%s", title, part.Content)
	default:
		return fmt.Sprintf("[Unknown: %s]", part.Type)
	}
}

func formatArgs(args map[string]interface{}) string {
	if len(args) == 0 {
		return ""
	}
	// Sort keys for deterministic output.
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		v := args[k]
		switch val := v.(type) {
		case string:
			lines = append(lines, fmt.Sprintf("  %s: %s", k, val))
		default:
			b, err := json.Marshal(val)
			if err != nil {
				lines = append(lines, fmt.Sprintf("  %s: <marshal error: %v>", k, err))
			} else {
				lines = append(lines, fmt.Sprintf("  %s: %s", k, string(b)))
			}
		}
	}
	return strings.Join(lines, "\n")
}

func resolvePartType(parts []ContentPart) string {
	types := make(map[ContentPartType]bool)
	for _, p := range parts {
		types[p.Type] = true
	}
	if len(types) == 1 {
		for t := range types {
			return string(t)
		}
	}
	if len(types) > 1 {
		return "mixed"
	}
	return "text"
}
