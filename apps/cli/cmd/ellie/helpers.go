package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

// findMonorepoRoot walks up from CWD looking for turbo.json.
// Supports ELLIE_ROOT env var override.
func findMonorepoRoot() (string, error) {
	if root := os.Getenv("ELLIE_ROOT"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "turbo.json")); err != nil {
			return "", fmt.Errorf("ELLIE_ROOT=%s does not contain turbo.json", root)
		}
		return root, nil
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("cannot determine working directory: %w", err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "turbo.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("cannot find monorepo root (looked for turbo.json). Set ELLIE_ROOT or run from within the project")
}

// findBin locates a binary on PATH or in the monorepo's node_modules/.bin.
func findBin(name string, root string) (string, error) {
	// Check PATH first
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}

	// Fall back to local node_modules/.bin
	local := filepath.Join(root, "node_modules", ".bin", name)
	if _, err := os.Stat(local); err == nil {
		return local, nil
	}

	return "", fmt.Errorf("%s not found in PATH or node_modules/.bin", name)
}

// runProcess spawns a child process, forwards signals, and returns its exit code.
func runProcess(name string, args []string, dir string) int {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		return 1
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		_ = cmd.Process.Signal(sig)
	}()

	err := cmd.Wait()
	signal.Stop(sigCh)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
