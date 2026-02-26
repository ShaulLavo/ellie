package main

import (
	"fmt"
	"os"
)

func cmdDev() {
	root, err := findMonorepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	turboPath, err := findBin("turbo", root)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	fmt.Println(styleBold.Render("Starting dev server..."))
	fmt.Println()

	exitCode := runProcess(turboPath, []string{"run", "dev", "--filter=!cli"}, root)
	os.Exit(exitCode)
}
