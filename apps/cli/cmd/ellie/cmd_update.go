package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Build and install the latest CLI from source",
	RunE:  runUpdate,
}

func runUpdate(cmd *cobra.Command, args []string) error {
	root, err := findMonorepoRoot()
	if err != nil {
		return err
	}

	cliDir := filepath.Join(root, "apps", "cli")

	// Pull latest changes
	fmt.Println(styleBold.Render("Pulling latest changes..."))
	pull := exec.Command("git", "pull")
	pull.Dir = root
	pull.Stdout = os.Stdout
	pull.Stderr = os.Stderr
	if err := pull.Run(); err != nil {
		return fmt.Errorf("git pull failed: %w", err)
	}

	// Build and install
	fmt.Println()
	fmt.Println(styleBold.Render("Installing ellie..."))
	install := exec.Command("go", "install", "./cmd/ellie")
	install.Dir = cliDir
	install.Stdout = os.Stdout
	install.Stderr = os.Stderr
	if err := install.Run(); err != nil {
		return fmt.Errorf("go install failed: %w", err)
	}

	fmt.Println()
	fmt.Println(styleOk.Render("✓"), "ellie updated successfully")
	return nil
}
