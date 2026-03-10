package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

var devCmd = &cobra.Command{
	Use:   "dev",
	Short: "Start development server (hot reload)",
	RunE:  runDev,
}

// killPort kills any process listening on the given TCP port.
func killPort(port string) {
	if runtime.GOOS == "windows" {
		return
	}
	out, err := exec.Command("lsof", "-ti:"+port).Output()
	if err != nil || len(out) == 0 {
		return
	}
	for _, pid := range strings.Fields(strings.TrimSpace(string(out))) {
		_ = exec.Command("kill", pid).Run()
	}
}

// killExistingEllie kills all processes from a previous ellie dev session.
// This prevents zombie server/watcher processes from accumulating.
func killExistingEllie() {
	if runtime.GOOS == "windows" {
		return
	}

	myPID := fmt.Sprintf("%d", os.Getpid())

	// Patterns that match processes spawned by "ellie dev"
	patterns := []string{
		"bun.*server\\.ts",    // bun run --hot src/server.ts
		"tailwindcss.*watch",  // bunx @tailwindcss/cli --watch
		"turbo.*run.*dev",     // turbo run dev
	}

	for _, pattern := range patterns {
		out, err := exec.Command("pgrep", "-f", pattern).Output()
		if err != nil || len(out) == 0 {
			continue
		}
		for _, pid := range strings.Fields(strings.TrimSpace(string(out))) {
			if pid == myPID {
				continue
			}
			_ = exec.Command("kill", pid).Run()
		}
	}
}

func runDev(cmd *cobra.Command, args []string) error {
	root, err := findMonorepoRoot()
	if err != nil {
		return err
	}

	turboPath, err := findBin("turbo", root)
	if err != nil {
		return err
	}

	killExistingEllie()
	killPort("3000")

	fmt.Println(styleBold.Render("Starting dev server..."))
	fmt.Println()

	if exitCode := runProcess(turboPath, []string{"run", "dev", "--filter=!cli"}, root); exitCode != 0 {
		return exitCodeError(exitCode)
	}
	return nil
}
