package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func cmdStart() {
	root, err := findMonorepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	binaryPath := filepath.Join(root, "dist", "server")
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "No production build found at dist/server. Build the project first.")
		os.Exit(1)
	}

	fmt.Println(styleBold.Render("Starting production server..."))
	fmt.Println()

	exitCode := runProcess(binaryPath, []string{}, root)
	os.Exit(exitCode)
}
