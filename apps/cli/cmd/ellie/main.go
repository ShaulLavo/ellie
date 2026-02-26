package main

import (
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

func baseURL() string {
	if u := os.Getenv("ELLIE_API_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return defaultBaseURL
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		os.Exit(1)
	}

	switch args[0] {
	case "dev":
		cmdDev()
	case "start":
		cmdStart()
	case "auth":
		if len(args) >= 2 {
			switch args[1] {
			case "status":
				cmdAuthStatus()
			case "clear":
				cmdAuthClear()
			default:
				fmt.Fprintf(os.Stderr, "Unknown auth command: %s\n", args[1])
				printUsage()
				os.Exit(1)
			}
		} else {
			cmdAuth()
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", args[0])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(styleBold.Render("Usage:"))
	fmt.Println("  ellie dev             Start development server (hot reload)")
	fmt.Println("  ellie start           Run production server (requires build)")
	fmt.Println("  ellie auth            Interactive authentication setup")
	fmt.Println("  ellie auth status     Show current auth status")
	fmt.Println("  ellie auth clear      Remove stored Anthropic credentials")
}
