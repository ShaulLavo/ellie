package main

import (
	"context"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
	"github.com/spf13/cobra"

	"ellie/apps/cli/internal/chatui"
)

var chatCmd = &cobra.Command{
	Use:   "chat",
	Short: "Open interactive chat TUI",
	RunE:  runChat,
}

var transcriptDir string

func init() {
	chatCmd.Flags().StringVar(&transcriptDir, "transcript-dir", ".", "Directory to save transcripts")
}

func runChat(cmd *cobra.Command, args []string) error {
	base := requireBaseURL()

	// Verify server is reachable
	client := chatui.NewHTTPClient(base)
	if _, err := client.GetStatus(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Cannot connect to server at "+base))
		fmt.Fprintln(os.Stderr, styleDim.Render("Make sure the server is running (ellie dev or ellie start)"))
		fmt.Fprintln(os.Stderr, styleDim.Render("Set ELLIE_API_URL if the server is at a different address"))
		return errSilent
	}

	model := chatui.NewModel(base, "current", transcriptDir)

	p := tea.NewProgram(model)

	// Start SSE loop in background goroutine with Program.Send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go model.StartSSELoop(ctx, p.Send)

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	return nil
}
