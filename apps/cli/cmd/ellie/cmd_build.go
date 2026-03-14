package main

import (
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
)

var buildCmd = &cobra.Command{
	Use:   "build",
	Short: "Build the production release bundle",
	RunE:  runBuild,
}

func runBuild(cmd *cobra.Command, args []string) error {
	root, err := findMonorepoRoot()
	if err != nil {
		return err
	}

	bunPath, err := findBin("bun", root)
	if err != nil {
		return err
	}

	script := filepath.Join(root, "scripts", "build-release.ts")

	fmt.Println(styleBold.Render("Building release bundle..."))
	fmt.Println()

	if exitCode := runProcess(bunPath, []string{"run", script}, root); exitCode != 0 {
		return exitCodeError(exitCode)
	}
	return nil
}
