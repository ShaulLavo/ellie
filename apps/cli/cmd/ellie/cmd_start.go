package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Run production server (requires build)",
	RunE:  runStart,
}

func runStart(cmd *cobra.Command, args []string) error {
	root, err := findMonorepoRoot()
	if err != nil {
		return err
	}

	startScript := filepath.Join(root, "dist", "release", "start.sh")
	if _, err := os.Stat(startScript); os.IsNotExist(err) {
		return fmt.Errorf("no production build found at dist/release — build the project first")
	}

	fmt.Println(styleBold.Render("Starting production server..."))
	fmt.Println()

	if exitCode := runProcess(startScript, []string{}, root); exitCode != 0 {
		return exitCodeError(exitCode)
	}
	return nil
}
