package main

import (
	"fmt"
	"strings"

	"ellie/apps/cli/internal/sysinfo"

	"github.com/spf13/cobra"
)

var (
	sysinfoSmall bool
	sysinfoJSON  bool
	sysinfoBars  bool
	sysinfoShow  string
)

var sysinfoCmd = &cobra.Command{
	Use:   "sysinfo",
	Short: "Display system information",
	Long: `Display system information with an ASCII logo.

Flags:
  --small    Use small ASCII logo variant
  --json     Output as JSON (no logo or styling)
  --bars     Show bar visualization for CPU, memory, disk, battery
  --show     Comma-separated list of readouts to display

Valid readout keys for --show:
  ` + strings.Join(sysinfo.AllKeyNames(), ", "),
	RunE: runSysinfo,
}

func init() {
	sysinfoCmd.Flags().BoolVar(&sysinfoSmall, "small", false, "use small ASCII logo variant")
	sysinfoCmd.Flags().BoolVar(&sysinfoJSON, "json", false, "output as JSON")
	sysinfoCmd.Flags().BoolVar(&sysinfoBars, "bars", false, "show bar visualization for percentages")
	sysinfoCmd.Flags().StringVar(&sysinfoShow, "show", "", "comma-separated list of readouts to display")
}

func runSysinfo(cmd *cobra.Command, args []string) error {
	// Parse --show filter (nil means collect all)
	var keys []sysinfo.ReadoutKey
	if sysinfoShow != "" {
		var err error
		keys, err = sysinfo.ParseShowKeys(sysinfoShow)
		if err != nil {
			return err
		}
	}

	// Collect only the needed readouts
	info := sysinfo.Collect(keys)

	// JSON output mode
	if sysinfoJSON {
		out, err := info.ToJSON()
		if err != nil {
			return err
		}
		fmt.Println(out)
		return nil
	}

	// Styled output
	fmt.Print(sysinfo.Render(info, sysinfo.RenderOpts{
		SmallLogo: sysinfoSmall,
		ShowBars:  sysinfoBars,
	}))
	return nil
}
