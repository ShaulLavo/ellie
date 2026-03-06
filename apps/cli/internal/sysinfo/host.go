package sysinfo

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

func fetchHost() Readout {
	u, err := user.Current()
	if err != nil {
		return Readout{Key: KeyHost, Err: err}
	}
	h, err := os.Hostname()
	if err != nil {
		return Readout{Key: KeyHost, Err: err}
	}
	// Strip .local suffix common on macOS
	h = strings.TrimSuffix(h, ".local")
	return Readout{Key: KeyHost, Value: fmt.Sprintf("%s@%s", u.Username, h)}
}

func fetchShell() Readout {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return Readout{Key: KeyShell, Err: fmt.Errorf("SHELL not set")}
	}
	name := filepath.Base(shell)

	// Try to get version
	out, err := exec.Command(shell, "--version").Output()
	if err == nil {
		line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
		// Extract version number from output like "zsh 5.9 (x86_64-apple-darwin23.0)"
		if parts := strings.Fields(line); len(parts) >= 2 {
			return Readout{Key: KeyShell, Value: fmt.Sprintf("%s %s", name, parts[1])}
		}
	}

	return Readout{Key: KeyShell, Value: name}
}

func fetchTerminal() Readout {
	term := os.Getenv("TERM_PROGRAM")
	if term == "" {
		term = os.Getenv("TERM")
	}
	if term == "" {
		return Readout{Key: KeyTerminal, Err: fmt.Errorf("unknown terminal")}
	}
	// Clean up common names
	term = strings.TrimSuffix(term, ".app")
	return Readout{Key: KeyTerminal, Value: term}
}
