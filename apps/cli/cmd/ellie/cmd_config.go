package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var configSetFlag string

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "View or update channel configuration",
}

var configWhatsAppCmd = &cobra.Command{
	Use:   "whatsapp",
	Short: "View or update WhatsApp settings",
	RunE:  runConfigWhatsApp,
}

func init() {
	configWhatsAppCmd.Flags().StringVar(&configSetFlag, "set", "",
		"Set a specific setting (e.g. --set dmPolicy=pairing)")
}

func runConfigWhatsApp(cmd *cobra.Command, args []string) error {
	// Fetch current settings
	resp, err := httpClient.Get(baseURL() + "/api/channels/whatsapp/status")
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var status struct {
		Accounts []struct {
			AccountID string                 `json:"accountId"`
			Settings  map[string]interface{} `json:"settings"`
		} `json:"accounts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	if len(status.Accounts) == 0 {
		fmt.Println(styleDim.Render("No WhatsApp accounts configured. Run 'ellie auth' first."))
		return nil
	}

	currentSettings := status.Accounts[0].Settings
	if currentSettings == nil {
		currentSettings = map[string]interface{}{}
	}

	// Non-interactive --set mode
	if configSetFlag != "" {
		return applyConfigSet(currentSettings)
	}

	// Display current settings
	fmt.Println()
	fmt.Println(styleBold.Render("Current WhatsApp Settings"))
	fmt.Println(strings.Repeat("─", 40))
	printSetting("DM Policy", currentSettings["dmPolicy"])
	printSetting("Self-Chat Mode", currentSettings["selfChatMode"])
	printSetting("Allow From", currentSettings["allowFrom"])
	printSetting("Group Policy", currentSettings["groupPolicy"])
	printSetting("Group Allow From", currentSettings["groupAllowFrom"])
	printSetting("Read Receipts", currentSettings["sendReadReceipts"])
	printSetting("Debounce (ms)", currentSettings["debounceMs"])
	printSetting("Media Max (MB)", currentSettings["mediaMaxMb"])
	printSetting("History Limit", currentSettings["historyLimit"])
	fmt.Println()

	// Ask if they want to edit
	var wantEdit bool
	err = huh.NewConfirm().
		Title("Edit settings?").
		Affirmative("Yes").
		Negative("No").
		Value(&wantEdit).
		Run()
	if err != nil || !wantEdit {
		return nil
	}

	// Interactive editor — re-use wizard prompts
	newSettings := map[string]any{}
	for k, v := range currentSettings {
		newSettings[k] = v
	}

	// DM Policy
	currentDM, _ := currentSettings["dmPolicy"].(string)
	if currentDM == "" {
		currentDM = "pairing"
	}
	var dmPolicy string = currentDM
	err = huh.NewSelect[string]().
		Title("Who can message the agent?").
		Description("Controls which DMs the agent will respond to").
		Options(
			huh.NewOption("Pairing (strangers get a code, you approve)", "pairing"),
			huh.NewOption("Only specific numbers (allowlist)", "allowlist"),
			huh.NewOption("Anyone (open)", "open"),
			huh.NewOption("Disabled (ignore all DMs)", "disabled"),
		).
		Value(&dmPolicy).
		Run()
	if err != nil {
		return errSilent
	}
	newSettings["dmPolicy"] = dmPolicy

	if dmPolicy == "allowlist" {
		existing := formatStringSlice(currentSettings["allowFrom"])
		var allowFromRaw string = existing
		err = huh.NewInput().
			Title("Allowed phone numbers").
			Description("Comma-separated, E.164 format").
			Placeholder("+15551234567, +15559876543").
			Value(&allowFromRaw).
			Run()
		if err != nil {
			return errSilent
		}
		var allowFrom []string
		for _, raw := range strings.Split(allowFromRaw, ",") {
			n := normalizeE164(raw)
			if n != "" {
				allowFrom = append(allowFrom, n)
			}
		}
		newSettings["allowFrom"] = allowFrom
	} else if dmPolicy == "open" {
		newSettings["allowFrom"] = []string{"*"}
	} else if dmPolicy == "pairing" {
		// Clear allowFrom for pairing mode (server handles)
		if existing, ok := newSettings["allowFrom"].([]interface{}); ok && len(existing) > 0 {
			// Keep existing approved numbers
		}
	}

	// Group Policy
	currentGroup, _ := currentSettings["groupPolicy"].(string)
	if currentGroup == "" {
		currentGroup = "disabled"
	}
	var groupPolicy string = currentGroup
	err = huh.NewSelect[string]().
		Title("Allow messages from WhatsApp groups?").
		Options(
			huh.NewOption("No (disabled)", "disabled"),
			huh.NewOption("Only specific senders (allowlist)", "allowlist"),
			huh.NewOption("Yes — anyone with @mention (open)", "open"),
		).
		Value(&groupPolicy).
		Run()
	if err != nil {
		return errSilent
	}
	newSettings["groupPolicy"] = groupPolicy

	if groupPolicy == "allowlist" {
		existing := formatStringSlice(currentSettings["groupAllowFrom"])
		var groupAllowFromRaw string = existing
		err = huh.NewInput().
			Title("Allowed group senders").
			Description("Comma-separated phone numbers (E.164) allowed to trigger in groups").
			Value(&groupAllowFromRaw).
			Run()
		if err != nil {
			return errSilent
		}
		var groupAllowFrom []string
		for _, raw := range strings.Split(groupAllowFromRaw, ",") {
			n := normalizeE164(raw)
			if n != "" {
				groupAllowFrom = append(groupAllowFrom, n)
			}
		}
		newSettings["groupAllowFrom"] = groupAllowFrom
	}

	// Read receipts
	currentReceipts := true
	if v, ok := currentSettings["sendReadReceipts"].(bool); ok {
		currentReceipts = v
	}
	var readReceipts bool = currentReceipts
	err = huh.NewConfirm().
		Title("Send read receipts?").
		Description("Show blue ticks when the bot reads messages").
		Affirmative("Yes").
		Negative("No").
		Value(&readReceipts).
		Run()
	if err != nil {
		return errSilent
	}
	newSettings["sendReadReceipts"] = readReceipts

	// POST updated settings
	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"settings":  newSettings,
	})
	resp2, err := httpClient.Post(baseURL()+"/api/channels/whatsapp/settings", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		return serverError(resp2)
	}

	fmt.Println(styleOk.Render("WhatsApp settings updated."))
	return nil
}

func applyConfigSet(currentSettings map[string]interface{}) error {
	parts := strings.SplitN(configSetFlag, "=", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid --set format, expected key=value (e.g. --set dmPolicy=pairing)")
	}

	key := strings.TrimSpace(parts[0])
	value := strings.TrimSpace(parts[1])

	newSettings := map[string]any{}
	for k, v := range currentSettings {
		newSettings[k] = v
	}

	// Handle type coercion for known fields
	switch key {
	case "selfChatMode", "sendReadReceipts":
		newSettings[key] = value == "true"
	case "debounceMs", "mediaMaxMb", "historyLimit":
		var num float64
		if _, err := fmt.Sscanf(value, "%f", &num); err != nil {
			return fmt.Errorf("invalid number for %s: %s", key, value)
		}
		newSettings[key] = num
	default:
		newSettings[key] = value
	}

	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"settings":  newSettings,
	})
	resp, err := httpClient.Post(baseURL()+"/api/channels/whatsapp/settings", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render(fmt.Sprintf("Set %s = %s", key, value)))
	return nil
}

func printSetting(label string, value interface{}) {
	if value == nil {
		fmt.Printf("  %-18s %s\n", label+":", styleDim.Render("(not set)"))
		return
	}
	switch v := value.(type) {
	case []interface{}:
		if len(v) == 0 {
			fmt.Printf("  %-18s %s\n", label+":", styleDim.Render("[]"))
		} else {
			strs := make([]string, len(v))
			for i, item := range v {
				strs[i] = fmt.Sprint(item)
			}
			fmt.Printf("  %-18s %s\n", label+":", strings.Join(strs, ", "))
		}
	default:
		fmt.Printf("  %-18s %v\n", label+":", v)
	}
}

func formatStringSlice(v interface{}) string {
	if v == nil {
		return ""
	}
	slice, ok := v.([]interface{})
	if !ok {
		return ""
	}
	strs := make([]string, 0, len(slice))
	for _, item := range slice {
		if s, ok := item.(string); ok {
			strs = append(strs, s)
		}
	}
	return strings.Join(strs, ", ")
}
