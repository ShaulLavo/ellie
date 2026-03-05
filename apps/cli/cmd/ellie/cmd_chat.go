package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"ellie/apps/cli/internal/chatui"
)

func cmdChat(args []string) error {
	fs := flag.NewFlagSet("chat", flag.ExitOnError)
	sessionFlag := fs.String("session", "current", "Session to connect to (only 'current' supported in v1)")
	transcriptDir := fs.String("transcript-dir", ".", "Directory to save transcripts")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// v1: only "current" session supported
	if *sessionFlag != "current" {
		return fmt.Errorf("only --session=current is supported in v1")
	}

	base := baseURL()

	// Verify server is reachable
	client := chatui.NewHTTPClient(base)
	if _, err := client.GetStatus(); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Cannot connect to server at "+base))
		fmt.Fprintln(os.Stderr, styleDim.Render("Make sure the server is running (ellie dev or ellie start)"))
		return errSilent
	}

	model := chatui.NewModel(base, *sessionFlag, *transcriptDir)

	p := tea.NewProgram(
		model,
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	// Start SSE loop in background goroutine with Program.Send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go model.StartSSELoop(ctx, p.Send)

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	return nil
}
