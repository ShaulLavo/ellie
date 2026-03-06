package main

import (
	"fmt"

	"ellie/apps/cli/internal/sysinfo"

	"github.com/spf13/cobra"
)

var sysinfoCmd = &cobra.Command{
	Use:   "sysinfo",
	Short: "Display system information",
	RunE:  runSysinfo,
}

func runSysinfo(cmd *cobra.Command, args []string) error {
	info := sysinfo.Collect()
	fmt.Print(sysinfo.Render(info))
	return nil
}
