package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

var devCmd = &cobra.Command{
	Use:   "dev",
	Short: "Start development server (hot reload)",
	RunE:  runDev,
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

	fmt.Println(styleBold.Render("Starting dev server..."))
	fmt.Println()

	if exitCode := runProcess(turboPath, []string{"run", "dev", "--filter=!cli"}, root); exitCode != 0 {
		return exitCodeError(exitCode)
	}
	return nil
}
