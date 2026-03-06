package sysinfo

import (
	"fmt"
	"os"
	"path/filepath"
)

func fetchPackages() Readout {
	var total int
	var sources []string

	// Homebrew (Apple Silicon)
	if n := countDir("/opt/homebrew/Cellar"); n > 0 {
		total += n
		sources = append(sources, fmt.Sprintf("%d (brew)", n))
	}
	// Homebrew (Intel)
	if n := countDir("/usr/local/Cellar"); n > 0 {
		total += n
		sources = append(sources, fmt.Sprintf("%d (brew)", n))
	}
	// Homebrew Casks
	for _, caskDir := range []string{"/opt/homebrew/Caskroom", "/usr/local/Caskroom"} {
		if n := countDir(caskDir); n > 0 {
			total += n
			sources = append(sources, fmt.Sprintf("%d (cask)", n))
		}
	}

	if total == 0 {
		return Readout{Key: KeyPackages, Err: fmt.Errorf("no package managers found")}
	}

	// Show breakdown if multiple sources, otherwise just the count
	if len(sources) == 1 {
		return Readout{Key: KeyPackages, Value: sources[0]}
	}
	return Readout{Key: KeyPackages, Value: fmt.Sprintf("%d (%s)", total, joinSources(sources))}
}

func countDir(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if e.IsDir() {
			count++
		}
	}
	return count
}

func joinSources(sources []string) string {
	result := ""
	for i, s := range sources {
		if i > 0 {
			result += ", "
		}
		// Strip the outer count, just keep the label
		result += s
	}
	return result
}

// Look for common macOS package manager paths
func homebrewPrefix() string {
	// Apple Silicon
	if _, err := os.Stat("/opt/homebrew"); err == nil {
		return "/opt/homebrew"
	}
	// Intel
	if _, err := os.Stat("/usr/local/Homebrew"); err == nil {
		return "/usr/local"
	}
	// Check PATH
	if p, err := filepath.EvalSymlinks("/usr/local/bin/brew"); err == nil {
		return filepath.Dir(filepath.Dir(p))
	}
	return ""
}
