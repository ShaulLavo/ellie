package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var pairCmd = &cobra.Command{
	Use:   "pair",
	Short: "Manage WhatsApp pairing requests",
}

var pairListCmd = &cobra.Command{
	Use:   "list",
	Short: "List pending pairing requests",
	RunE:  runPairList,
}

var pairApproveCmd = &cobra.Command{
	Use:   "approve [code]",
	Short: "Approve a pairing request by code",
	Args:  cobra.ExactArgs(1),
	RunE:  runPairApprove,
}

func runPairList(cmd *cobra.Command, args []string) error {
	resp, err := httpClient.Get(baseURL() + "/api/channels/whatsapp/pairing/list?accountId=default")
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var requests []struct {
		ID         string `json:"id"`
		Code       string `json:"code"`
		CreatedAt  string `json:"createdAt"`
		LastSeenAt string `json:"lastSeenAt"`
		Meta       *struct {
			Name *string `json:"name,omitempty"`
		} `json:"meta,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&requests); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	if len(requests) == 0 {
		fmt.Println(styleDim.Render("No pending pairing requests."))
		return nil
	}

	fmt.Println()
	fmt.Println(styleBold.Render("Pending Pairing Requests"))
	fmt.Println(strings.Repeat("─", 60))
	fmt.Printf("  %-10s %-18s %-12s %s\n", "CODE", "SENDER", "NAME", "SINCE")
	fmt.Println(strings.Repeat("─", 60))

	for _, r := range requests {
		name := ""
		if r.Meta != nil && r.Meta.Name != nil {
			name = *r.Meta.Name
		}
		since := ""
		if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
			since = formatDuration(time.Since(t))
		}
		fmt.Printf("  %-10s %-18s %-12s %s\n", r.Code, r.ID, name, since)
	}
	fmt.Println()
	fmt.Println(styleDim.Render("Approve with: ellie pair approve <code>"))
	return nil
}

func runPairApprove(cmd *cobra.Command, args []string) error {
	code := strings.TrimSpace(args[0])
	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"code":      code,
	})
	resp, err := httpClient.Post(baseURL()+"/api/channels/whatsapp/pairing/approve", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		fmt.Println(styleErr.Render("No pending request with code: " + code))
		return nil
	}

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var result struct {
		OK       bool   `json:"ok"`
		SenderID string `json:"senderId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	fmt.Println(styleOk.Render(fmt.Sprintf("Approved %s — they can now message the bot.", result.SenderID)))
	return nil
}
