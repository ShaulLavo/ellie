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
// Handles shell-escaped, space-separated, newline-separated, and quoted paths.
func parseFilePaths(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	// Strip file:// URL prefix (some terminals paste this on drag)
	text = strings.TrimPrefix(text, "file://")

	var candidates []string

	// First try splitting by newlines (common for multi-file drag)
	lines := strings.Split(text, "\n")
	if len(lines) > 1 {
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			line = strings.TrimPrefix(line, "file://")
			candidates = append(candidates, cleanPath(line))
		}
	} else {
		// Single line: could be one path or space-separated shell-escaped paths.
		// First try the whole thing as one path (unquote + shell-unescape).
		single := cleanPath(text)
		if _, err := os.Stat(single); err == nil {
			return []string{single}
		}
		// Try splitting on unescaped spaces (terminals separate dragged files
		// with actual spaces, while spaces *within* paths are backslash-escaped).
		candidates = splitShellPaths(text)
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

// splitShellPaths splits text on unescaped spaces, treating `\ ` as a literal
// space within a path. This matches how macOS terminals paste multiple dragged
// file paths: spaces between paths are literal, spaces within paths are escaped.
func splitShellPaths(text string) []string {
	var paths []string
	var current strings.Builder
	i := 0
	for i < len(text) {
		if text[i] == '\\' && i+1 < len(text) {
			// Escaped character — include the literal char (skip the backslash)
			current.WriteByte(text[i+1])
			i += 2
			continue
		}
		if text[i] == ' ' || text[i] == '\t' {
			// Unescaped space — path boundary
			if current.Len() > 0 {
				paths = append(paths, current.String())
				current.Reset()
			}
			i++
			continue
		}
		current.WriteByte(text[i])
		i++
	}
	if current.Len() > 0 {
		paths = append(paths, current.String())
	}
	return paths
}

// shellUnescape removes shell backslash escaping from a string.
// E.g., `my\ file\ \(1\).png` → `my file (1).png`.
func shellUnescape(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] == '\\' && i+1 < len(s) {
			b.WriteByte(s[i+1])
			i += 2
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// cleanPath strips quotes, shell-escaping, and trims whitespace from a path.
func cleanPath(s string) string {
	s = strings.TrimSpace(s)
	// Strip surrounding quotes
	if len(s) >= 2 {
		if (s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"') {
			return s[1 : len(s)-1]
		}
	}
	// Remove shell escaping
	return shellUnescape(s)
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
