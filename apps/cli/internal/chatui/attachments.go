package chatui

import (
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// extraMimeTypes maps file extensions not covered by Go's mime package
// to their MIME types. Mirrors the server-side text extension list.
var extraMimeTypes = map[string]string{
	".ts":      "text/typescript",
	".tsx":     "text/typescript",
	".jsx":     "text/javascript",
	".mjs":     "text/javascript",
	".cjs":     "text/javascript",
	".yaml":    "application/x-yaml",
	".yml":     "application/x-yaml",
	".toml":    "application/toml",
	".md":      "text/markdown",
	".mdx":     "text/markdown",
	".csv":     "text/csv",
	".tsv":     "text/tab-separated-values",
	".scss":    "text/scss",
	".less":    "text/less",
	".py":      "text/x-python",
	".rb":      "text/x-ruby",
	".rs":      "text/x-rust",
	".go":      "text/x-go",
	".java":    "text/x-java",
	".kt":      "text/x-kotlin",
	".c":       "text/x-c",
	".h":       "text/x-c",
	".cpp":     "text/x-c++",
	".hpp":     "text/x-c++",
	".cs":      "text/x-csharp",
	".swift":   "text/x-swift",
	".sh":      "text/x-shellscript",
	".bash":    "text/x-shellscript",
	".zsh":     "text/x-shellscript",
	".fish":    "text/x-shellscript",
	".sql":     "application/sql",
	".graphql": "application/graphql",
	".gql":     "application/graphql",
	".env":     "text/plain",
	".ini":     "text/plain",
	".cfg":     "text/plain",
	".conf":    "text/plain",
	".vue":     "text/html",
	".svelte":  "text/html",
	".astro":   "text/html",
}

// detectMime returns a MIME type for the given filename.
func detectMime(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return "application/octet-stream"
	}
	// Try Go's built-in registry first
	if m := mime.TypeByExtension(ext); m != "" {
		return m
	}
	// Fall back to our extended map
	if m, ok := extraMimeTypes[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

// mimeCategory returns a display category for a MIME type.
func mimeCategory(mimeType string) string {
	switch {
	case strings.HasPrefix(mimeType, "image/"):
		return "image"
	case strings.HasPrefix(mimeType, "video/"):
		return "video"
	case strings.HasPrefix(mimeType, "audio/"):
		return "audio"
	case strings.HasPrefix(mimeType, "text/"),
		strings.HasPrefix(mimeType, "application/json"),
		strings.HasPrefix(mimeType, "application/xml"),
		strings.HasPrefix(mimeType, "application/javascript"),
		strings.HasPrefix(mimeType, "application/typescript"),
		strings.HasPrefix(mimeType, "application/x-yaml"),
		strings.HasPrefix(mimeType, "application/toml"),
		strings.HasPrefix(mimeType, "application/sql"),
		strings.HasPrefix(mimeType, "application/graphql"):
		return "text"
	default:
		return "file"
	}
}

// parseFilePaths attempts to extract valid file paths from pasted text.
// Returns nil if any candidate is not a valid existing file path.
// Handles space-separated, newline-separated, and quoted paths.
func parseFilePaths(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	var candidates []string

	// First try splitting by newlines (common for multi-file drag)
	lines := strings.Split(text, "\n")
	if len(lines) > 1 {
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			candidates = append(candidates, unquote(line))
		}
	} else {
		// Single line: could be one path or space-separated paths.
		// Try the whole thing as one path first.
		single := unquote(text)
		if _, err := os.Stat(single); err == nil {
			return []string{single}
		}
		// Try space-separated (terminals separate multiple dragged files with spaces)
		// But be careful: a single path might contain spaces. So we try to be smart:
		// Split by spaces, then try to recombine greedily.
		candidates = splitSmartPaths(text)
	}

	if len(candidates) == 0 {
		return nil
	}

	// Validate ALL candidates exist as files
	var valid []string
	for _, c := range candidates {
		info, err := os.Stat(c)
		if err != nil || info.IsDir() {
			return nil // any failure → treat entire paste as text
		}
		valid = append(valid, c)
	}
	return valid
}

// splitSmartPaths tries to split space-separated paths, handling quoted paths.
// It processes tokens left-to-right, combining with spaces when the combined
// path exists as a file.
func splitSmartPaths(text string) []string {
	// If the text contains quoted segments, handle them specially
	var paths []string
	remaining := text

	for remaining != "" {
		remaining = strings.TrimLeft(remaining, " \t")
		if remaining == "" {
			break
		}

		// Check for quoted path
		if remaining[0] == '\'' || remaining[0] == '"' {
			quote := remaining[0]
			end := strings.IndexByte(remaining[1:], quote)
			if end >= 0 {
				paths = append(paths, remaining[1:1+end])
				remaining = remaining[2+end:]
				continue
			}
		}

		// Unquoted: find the next space
		spaceIdx := strings.IndexByte(remaining, ' ')
		if spaceIdx < 0 {
			paths = append(paths, remaining)
			break
		}

		token := remaining[:spaceIdx]
		remaining = remaining[spaceIdx+1:]

		// Check if token alone is a valid file
		if _, err := os.Stat(token); err == nil {
			paths = append(paths, token)
		} else {
			// Maybe the path contains spaces — try combining with next tokens
			combined := token
			found := false
			rest := remaining
			for rest != "" {
				nextSpace := strings.IndexByte(rest, ' ')
				var next string
				if nextSpace < 0 {
					next = rest
					rest = ""
				} else {
					next = rest[:nextSpace]
					rest = rest[nextSpace+1:]
				}
				combined += " " + next
				if _, err := os.Stat(combined); err == nil {
					paths = append(paths, combined)
					remaining = rest
					found = true
					break
				}
			}
			if !found {
				// Can't resolve — return the token and let validation fail
				paths = append(paths, token)
			}
		}
	}
	return paths
}

// unquote strips surrounding single or double quotes.
func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// newPendingAttachment creates a PendingAttachment from a validated file path.
func newPendingAttachment(filePath string) PendingAttachment {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		absPath = filePath
	}
	name := filepath.Base(absPath)
	m := detectMime(name)
	cat := mimeCategory(m)

	var size int64
	if info, err := os.Stat(absPath); err == nil {
		size = info.Size()
	}

	return PendingAttachment{
		FilePath: absPath,
		Name:     name,
		Mime:     m,
		Size:     size,
		Category: cat,
	}
}

// attachmentPillLabel returns the display label for an attachment pill.
// Images → "Image", others → file extension (e.g., ".toml", ".go").
func attachmentPillLabel(a PendingAttachment) string {
	switch a.Category {
	case "image":
		return "Image"
	case "video":
		return "Video"
	case "audio":
		return "Audio"
	default:
		ext := filepath.Ext(a.Name)
		if ext != "" {
			return ext
		}
		return "File"
	}
}
