package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

var allowCmd = &cobra.Command{
	Use:   "allow",
	Short: "Manage WhatsApp allowed senders",
}

var allowListCmd = &cobra.Command{
	Use:   "list",
	Short: "Show allowed phone numbers (config + approved)",
	RunE:  runAllowList,
}

var allowAddCmd = &cobra.Command{
	Use:   "add [number]",
	Short: "Allow a phone number to message the bot",
	Args:  cobra.ExactArgs(1),
	RunE:  runAllowAdd,
}

var allowRemoveCmd = &cobra.Command{
	Use:   "remove [number]",
	Short: "Remove a phone number from the allow list",
	Args:  cobra.ExactArgs(1),
	RunE:  runAllowRemove,
}

func runAllowList(cmd *cobra.Command, args []string) error {
	resp, err := httpClient.Get(baseURL() + "/api/channels/whatsapp/allow/list?accountId=default")
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var result struct {
		Config  []string `json:"config"`
		Runtime []string `json:"runtime"`
		Merged  []string `json:"merged"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	fmt.Println()
	fmt.Println(styleBold.Render("Allowed Senders (WhatsApp)"))
	fmt.Println(strings.Repeat("─", 30))

	fmt.Println("  Config:")
	if len(result.Config) == 0 {
		fmt.Println("    (none)")
	} else {
		for _, n := range result.Config {
			fmt.Println("    " + n)
		}
	}

	fmt.Println("  Approved (via pairing):")
	if len(result.Runtime) == 0 {
		fmt.Println("    (none)")
	} else {
		for _, n := range result.Runtime {
			fmt.Println("    " + n)
		}
	}

	fmt.Println("  Merged (effective):")
	if len(result.Merged) == 0 {
		fmt.Println("    (none)")
	} else {
		for _, n := range result.Merged {
			fmt.Println("    " + n)
		}
	}
	fmt.Println()
	return nil
}

func runAllowAdd(cmd *cobra.Command, args []string) error {
	number := strings.TrimSpace(args[0])
	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"number":    number,
	})
	resp, err := httpClient.Post(baseURL()+"/api/channels/whatsapp/allow/add", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var result struct {
		OK         bool   `json:"ok"`
		Normalized string `json:"normalized"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	fmt.Println(styleOk.Render(fmt.Sprintf("Added %s to allow list.", result.Normalized)))
	return nil
}

func runAllowRemove(cmd *cobra.Command, args []string) error {
	number := strings.TrimSpace(args[0])
	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"number":    number,
	})
	resp, err := httpClient.Post(baseURL()+"/api/channels/whatsapp/allow/remove", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render(fmt.Sprintf("Removed %s from allow list.", number)))
	return nil
}
