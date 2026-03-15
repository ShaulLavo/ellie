package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	tea "charm.land/bubbletea/v2"
	"github.com/spf13/cobra"

	"ellie/apps/cli/internal/chatui"
)

var chatCmd = &cobra.Command{
	Use:   "chat",
	Short: "Open interactive chat TUI",
	RunE:  runChat,
}

var (
	transcriptDir string
	promptText    string
	outputFormat  string
)

func init() {
	chatCmd.Flags().StringVar(&transcriptDir, "transcript-dir", ".", "Directory to save transcripts")
	chatCmd.Flags().StringVarP(&promptText, "prompt", "P", "", "One-shot prompt (skip TUI, print response, exit)")
	chatCmd.Flags().StringVar(&outputFormat, "format", "markdown", "Output format for --prompt: text, markdown, json")
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

	// One-shot mode
	if promptText != "" {
		return runOneShot(base, promptText, outputFormat)
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

func runOneShot(baseURL, prompt, format string) error {
	switch format {
	case "text", "markdown", "json":
	default:
		fmt.Fprintf(os.Stderr, "invalid format %q: must be text, markdown, or json\n", format)
		return errSilent
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	cfg := chatui.OneShotConfig{
		BaseURL:  baseURL,
		BranchID: "current",
		Format:   format,
	}

	result, err := chatui.RunOneShot(ctx, cfg, prompt)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		return errSilent
	}

	if result.Error != "" {
		fmt.Fprintln(os.Stderr, styleErr.Render("Agent error:"), result.Error)
	}

	output, err := chatui.FormatResult(result, format)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Format error:"), err)
		return errSilent
	}

	fmt.Println(output)
	return nil
}
