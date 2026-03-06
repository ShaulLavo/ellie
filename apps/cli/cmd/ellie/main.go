package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/spf13/cobra"
)

const defaultBaseURL = "http://localhost:3000"

var (
	styleBold  = lipgloss.NewStyle().Bold(true)
	styleOk    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00A66D"))
	styleErr   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#EF4444"))
	styleDim   = lipgloss.NewStyle().Foreground(lipgloss.Color("#A1A1AA"))
	httpClient = &http.Client{Timeout: 10 * time.Second}
)

// errSilent signals a non-zero exit without additional output from main.
// Functions that return errSilent have already printed any necessary messages.
var errSilent = errors.New("")

// exitCodeError propagates a child-process exit code through the error chain.
type exitCodeError int

func (e exitCodeError) Error() string { return fmt.Sprintf("exit code %d", int(e)) }

func baseURL() string {
	if u := os.Getenv("ELLIE_API_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return defaultBaseURL
}

// requireBaseURL returns the base URL or an error if ELLIE_API_URL is unset
// and we're not using the default. For commands that talk to the server,
// this validates connectivity requirements early.
func requireBaseURL() string {
	return baseURL()
}

var rootCmd = &cobra.Command{
	Use:   "ellie",
	Short: "Ellie — AI personal assistant",
	CompletionOptions: cobra.CompletionOptions{
		DisableDefaultCmd: true,
	},
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	rootCmd.AddCommand(chatCmd)
	rootCmd.AddCommand(devCmd)
	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(authStatusCmd)
	authCmd.AddCommand(authClearCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		var ec exitCodeError
		if errors.As(err, &ec) {
			os.Exit(int(ec))
		}
		if !errors.Is(err, errSilent) {
			fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		}
		os.Exit(1)
	}
}
