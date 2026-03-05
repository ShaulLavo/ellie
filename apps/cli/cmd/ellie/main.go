package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
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

func main() {
	if err := run(); err != nil {
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

func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		return errSilent
	}

	switch args[0] {
	case "dev":
		return cmdDev()
	case "start":
		return cmdStart()
	case "auth":
		return runAuth(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", args[0])
		printUsage()
		return errSilent
	}
}

func runAuth(args []string) error {
	if len(args) == 0 {
		return cmdAuth()
	}
	switch args[0] {
	case "status":
		return cmdAuthStatus()
	case "clear":
		return cmdAuthClear()
	default:
		fmt.Fprintf(os.Stderr, "Unknown auth command: %s\n", args[0])
		printUsage()
		return errSilent
	}
}

func printUsage() {
	fmt.Println(styleBold.Render("Usage:"))
	fmt.Println("  ellie dev             Start development server (hot reload)")
	fmt.Println("  ellie start           Run production server (requires build)")
	fmt.Println("  ellie auth            Interactive authentication setup")
	fmt.Println("  ellie auth status     Show current auth status")
	fmt.Println("  ellie auth clear      Remove stored credentials (choose provider)")
}
