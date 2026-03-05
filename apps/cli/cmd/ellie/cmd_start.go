package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func cmdStart() error {
	root, err := findMonorepoRoot()
	if err != nil {
		return err
	}

	binaryPath := filepath.Join(root, "dist", "server")
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		return fmt.Errorf("no production build found at dist/server — build the project first")
	}

	fmt.Println(styleBold.Render("Starting production server..."))
	fmt.Println()

	if exitCode := runProcess(binaryPath, []string{}, root); exitCode != 0 {
		return exitCodeError(exitCode)
	}
	return nil
}
