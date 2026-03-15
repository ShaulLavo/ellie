package chatui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"golang.org/x/term"
)

// OneShotConfig configures a non-interactive one-shot chat.
type OneShotConfig struct {
	BaseURL   string
	BranchID string
	Format    string // "text", "markdown", "json"
}

// OneShotResult holds the response from a one-shot chat.
type OneShotResult struct {
	Role             string  `json:"role"`
	Content          string  `json:"content"`
	Model            *string `json:"model,omitempty"`
	Provider         *string `json:"provider,omitempty"`
	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	TotalCost        float64 `json:"totalCost"`
	StopReason       string  `json:"stopReason,omitempty"`
	Error            string  `json:"error,omitempty"`
}

const oneShotTimeout = 5 * time.Minute

// RunOneShot sends a single prompt and waits for the agent to complete.
// It bypasses the Bubble Tea TUI entirely.
func RunOneShot(ctx context.Context, cfg OneShotConfig, prompt string) (*OneShotResult, error) {
	ctx, cancel := context.WithTimeout(ctx, oneShotTimeout)
	defer cancel()

	client := NewHTTPClient(cfg.BaseURL)

	// Start SSE reader in background.
	eventCh := make(chan sseEvent, 64)
	go sseReadEvents(ctx, cfg.BaseURL, cfg.BranchID, eventCh)

	// Wait for the snapshot before sending the message.
	var snapshotMaxSeq int

	snapshotReceived := false
	for ev := range eventCh {
		if ev.Err != nil {
			return nil, fmt.Errorf("SSE connection error: %w", ev.Err)
		}
		if ev.Kind == "snapshot" {
			for _, row := range ev.Rows {
				if row.Seq > snapshotMaxSeq {
					snapshotMaxSeq = row.Seq
				}
			}
			snapshotReceived = true
			break
		}
	}
	if !snapshotReceived {
		return nil, fmt.Errorf("SSE stream closed before snapshot")
	}

	// Send the user message.
	if err := client.SendMessage(ctx, cfg.BranchID, prompt, nil); err != nil {
		return nil, fmt.Errorf("send message: %w", err)
	}

	// Process events until agent run completes.
	// turnEvents tracks only this turn's events for accurate stats.
	var (
		agentStarted     bool
		finalAssistantEv *EventRow
		errorMessage     string
		turnEvents       []EventRow
	)

	for ev := range eventCh {
		if ev.Err != nil {
			return nil, fmt.Errorf("SSE error: %w", ev.Err)
		}

		switch ev.Kind {
		case "append":
			row := ev.Row
			// Only consider events after our message.
			if row.Seq > 0 && row.Seq <= snapshotMaxSeq {
				continue
			}
			turnEvents = append(turnEvents, row)

			if IsAgentStart(row.Type) {
				agentStarted = true
			}
			if IsAgentEnd(row.Type) && agentStarted {
				return buildResult(finalAssistantEv, turnEvents, errorMessage), nil
			}
			if row.Type == "assistant_message" {
				finalAssistantEv = &row
			}
			if row.Type == "error" {
				stored := EventToStored(row)
				errorMessage = stored.Text
			}

		case "update":
			row := ev.Row
			// Upsert into turnEvents.
			found := false
			for i, e := range turnEvents {
				if e.ID == row.ID {
					turnEvents[i] = row
					found = true
					break
				}
			}
			if !found {
				turnEvents = append(turnEvents, row)
			}

			if row.Type == "assistant_message" {
				finalAssistantEv = &row
			}
		}
	}

	// Channel closed without seeing agent_end — partial result.
	if finalAssistantEv != nil {
		result := buildResult(finalAssistantEv, turnEvents, errorMessage)
		if result.Error == "" {
			result.Error = "stream ended before agent completed"
		}
		return result, nil
	}
	return nil, fmt.Errorf("SSE stream ended without a response")
}

func buildResult(assistantEv *EventRow, allEvents []EventRow, errorMsg string) *OneShotResult {
	result := &OneShotResult{Role: "assistant", Error: errorMsg}

	if assistantEv != nil {
		stored := EventToStored(*assistantEv)
		result.Content = stored.Text

		// Extract stopReason from payload.
		parsed := parsePayload(assistantEv.Payload)
		if sr, ok := parsed["stopReason"].(string); ok {
			result.StopReason = sr
			if sr == "error" {
				if em, ok := parsed["errorMessage"].(string); ok && result.Error == "" {
					result.Error = em
				}
			}
		}
	}

	stats := ComputeStatsFromEvents(allEvents)
	result.Model = stats.Model
	result.Provider = stats.Provider
	result.PromptTokens = stats.PromptTokens
	result.CompletionTokens = stats.CompletionTokens
	result.TotalCost = stats.TotalCost

	return result
}

// FormatResult formats the one-shot result for terminal output.
func FormatResult(result *OneShotResult, format string) (string, error) {
	switch format {
	case "text":
		return result.Content, nil
	case "markdown":
		w := termWidth()
		if w > maxMessageWidth {
			w = maxMessageWidth
		}
		return renderMarkdown(result.Content, w), nil
	case "json":
		b, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return "", fmt.Errorf("marshal result: %w", err)
		}
		return string(b), nil
	default:
		return "", fmt.Errorf("unknown format %q", format)
	}
}

func termWidth() int {
	if w, _, err := term.GetSize(int(os.Stdout.Fd())); err == nil && w > 0 {
		return w
	}
	return 80
}

// sseReadEvents opens a single SSE connection and sends parsed events to ch.
// It closes ch when done. No reconnection — fails fast for one-shot use.
func sseReadEvents(ctx context.Context, baseURL, branchID string, ch chan<- sseEvent) {
	defer close(ch)

	body, err := connectSSE(ctx, baseURL, branchID)
	if err != nil {
		ch <- sseEvent{Err: err}
		return
	}
	defer body.Close()

	readErr := readSSEStream(ctx, body, func(ev sseEvent) {
		ch <- ev
	})
	if readErr != nil {
		ch <- sseEvent{Err: readErr}
	}
}
