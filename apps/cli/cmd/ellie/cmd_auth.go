package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// waitForEnter pauses until the user presses Enter.
// Used after errors so the message stays visible before the TUI redraws.
func waitForEnter() {
	fmt.Println(styleDim.Render("\nPress Enter to continue..."))
	bufio.NewReader(os.Stdin).ReadBytes('\n')
}

// serverError builds a human-readable error from a non-200 server response.
// It tries to parse JSON {"error":"..."} and adds context for common codes.
func serverError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)

	// Try to extract a message from JSON body
	msg := strings.TrimSpace(string(body))
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != "" {
		msg = parsed.Error
	}

	switch resp.StatusCode {
	case 404:
		return fmt.Errorf("server returned 404 — the server may not be running or is missing this route (%s)", baseURL())
	case 403:
		return fmt.Errorf("forbidden — auth routes are only available from localhost")
	case 500:
		return fmt.Errorf("server error: %s", msg)
	default:
		if msg != "" {
			return fmt.Errorf("server returned %d: %s", resp.StatusCode, msg)
		}
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}
}

// ── auth (interactive wizard) ────────────────────────────────────────────────

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Interactive authentication setup",
	RunE:  runAuthWizard,
}

func runAuthWizard(cmd *cobra.Command, args []string) error {
	var provider string
	err := huh.NewSelect[string]().
		Title("Choose a provider to authenticate").
		Options(
			huh.NewOption("Anthropic", "anthropic"),
			huh.NewOption("Groq", "groq"),
			huh.NewOption("Brave Search", "brave"),
			huh.NewOption("WhatsApp", "whatsapp"),
		).
		Value(&provider).
		Run()
	if err != nil {
		return errSilent
	}

	switch provider {
	case "anthropic":
		return authAnthropic()
	case "groq":
		return authGroq()
	case "brave":
		return authBraveSearch()
	case "whatsapp":
		return authWhatsApp()
	}
	return nil
}

// ── auth status ──────────────────────────────────────────────────────────────

var authStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current auth status",
	RunE:  runAuthStatus,
}

func runAuthStatus(cmd *cobra.Command, args []string) error {
	fmt.Println()
	fmt.Println(styleBold.Render("Auth Status"))
	fmt.Println(strings.Repeat("─", 40))

	if err := printProviderStatus("Anthropic", "/api/auth/anthropic/status"); err != nil {
		return err
	}
	if err := printProviderStatus("Groq", "/api/auth/groq/status"); err != nil {
		return err
	}
	if err := printProviderStatus("Brave Search", "/api/auth/brave/status"); err != nil {
		return err
	}

	// Channel statuses (non-fatal if server doesn't support channels yet)
	_ = printChannelStatuses()

	fmt.Println()
	return nil
}

func printProviderStatus(name string, path string) error {
	url := baseURL() + path
	resp, err := httpClient.Get(url)
	if err != nil {
		return fmt.Errorf("cannot reach server at %s — make sure the server is running", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var status struct {
		Mode       *string  `json:"mode"`
		Source     string   `json:"source"`
		Configured bool     `json:"configured"`
		ExpiresAt  *float64 `json:"expires_at,omitempty"`
		Expired    *bool    `json:"expired,omitempty"`
		Preview    *string  `json:"preview,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	fmt.Println()
	fmt.Println(styleBold.Render("  " + name))

	if !status.Configured || status.Mode == nil {
		fmt.Println("    Not configured")
		return nil
	}

	fmt.Println("    Mode:   ", *status.Mode)
	fmt.Println("    Source:  ", status.Source)

	if status.Preview != nil {
		fmt.Println("    Key:    ", *status.Preview)
	}

	if status.ExpiresAt != nil {
		exp := time.UnixMilli(int64(*status.ExpiresAt))
		expStr := exp.Format(time.RFC3339)
		if status.Expired != nil && *status.Expired {
			expStr += " (EXPIRED)"
		}
		fmt.Println("    Expires:", expStr)
	}
	return nil
}

// ── auth clear ───────────────────────────────────────────────────────────────

var authClearCmd = &cobra.Command{
	Use:   "clear",
	Short: "Remove stored credentials (choose provider)",
	RunE:  runAuthClear,
}

func runAuthClear(cmd *cobra.Command, args []string) error {
	var target string
	err := huh.NewSelect[string]().
		Title("Which provider credentials should be cleared?").
		Options(
			huh.NewOption("Anthropic", "anthropic"),
			huh.NewOption("Groq", "groq"),
			huh.NewOption("Brave Search", "brave"),
			huh.NewOption("WhatsApp", "whatsapp"),
			huh.NewOption("All providers", "all"),
		).
		Value(&target).
		Run()
	if err != nil {
		return errSilent
	}

	// Confirm before clearing
	var confirm bool
	label := target
	if target == "all" {
		label = "all providers"
	}
	err = huh.NewConfirm().
		Title(fmt.Sprintf("Clear %s credentials?", label)).
		Affirmative("Yes, clear").
		Negative("Cancel").
		Value(&confirm).
		Run()
	if err != nil || !confirm {
		fmt.Println("Cancelled.")
		return errSilent
	}

	switch target {
	case "anthropic":
		return clearProvider("Anthropic", "/api/auth/anthropic/clear")
	case "groq":
		return clearProvider("Groq", "/api/auth/groq/clear")
	case "brave":
		return clearProvider("Brave Search", "/api/auth/brave/clear")
	case "whatsapp":
		return clearChannel("WhatsApp", "whatsapp")
	case "all":
		if err := clearProvider("Anthropic", "/api/auth/anthropic/clear"); err != nil {
			return err
		}
		if err := clearProvider("Groq", "/api/auth/groq/clear"); err != nil {
			return err
		}
		if err := clearProvider("Brave Search", "/api/auth/brave/clear"); err != nil {
			return err
		}
		_ = clearChannel("WhatsApp", "whatsapp") // non-fatal
		return nil
	}
	return nil
}

func clearProvider(name string, path string) error {
	url := baseURL() + path
	resp, err := httpClient.Post(url, "application/json", nil)
	if err != nil {
		return fmt.Errorf("cannot reach server at %s", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var result struct {
		Cleared bool `json:"cleared"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	if result.Cleared {
		fmt.Println(styleOk.Render(name + " credentials removed."))
	} else {
		fmt.Println("No stored " + name + " credentials found.")
	}
	return nil
}

// ── anthropic auth flows ─────────────────────────────────────────────────────

func authAnthropic() error {
	var method string
	err := huh.NewSelect[string]().
		Title("How would you like to authenticate with Anthropic?").
		Options(
			huh.NewOption("API Key", "api_key"),
			huh.NewOption("OAuth (Max/Pro plan — claude.ai)", "oauth_max"),
			huh.NewOption("OAuth (Console — creates API key)", "oauth_console"),
			huh.NewOption("Bearer Token", "token"),
		).
		Value(&method).
		Run()
	if err != nil {
		return errSilent
	}

	switch method {
	case "api_key":
		return authApiKey()
	case "oauth_max":
		return authOAuth("max")
	case "oauth_console":
		return authOAuth("console")
	case "token":
		return authToken()
	}
	return nil
}

func authGroq() error {
	var key string
	err := huh.NewInput().
		Title("Enter your Groq API key").
		Description("Get one at https://console.groq.com/keys").
		Placeholder("gsk_...").
		EchoMode(huh.EchoModePassword).
		Value(&key).
		Run()
	if err != nil || strings.TrimSpace(key) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		return errSilent
	}

	fmt.Println(styleDim.Render("Validating key..."))

	body, _ := json.Marshal(map[string]any{
		"key":      strings.TrimSpace(key),
		"validate": true,
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/groq/api-key", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("invalid API key — check the key and try again")
	}

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render("Groq API key saved successfully."))
	return nil
}

func authBraveSearch() error {
	var key string
	err := huh.NewInput().
		Title("Enter your Brave Search API key").
		Description("Get one at https://brave.com/search/api/").
		Placeholder("BSA...").
		EchoMode(huh.EchoModePassword).
		Value(&key).
		Run()
	if err != nil || strings.TrimSpace(key) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		return errSilent
	}

	fmt.Println(styleDim.Render("Validating key..."))

	body, _ := json.Marshal(map[string]any{
		"key":      strings.TrimSpace(key),
		"validate": true,
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/brave/api-key", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("invalid API key — check the key and try again")
	}

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render("Brave Search API key saved successfully."))
	return nil
}

func authApiKey() error {
	var key string
	err := huh.NewInput().
		Title("Enter your Anthropic API key").
		Placeholder("sk-ant-...").
		EchoMode(huh.EchoModePassword).
		Value(&key).
		Run()
	if err != nil || strings.TrimSpace(key) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		return errSilent
	}

	fmt.Println(styleDim.Render("Validating key..."))

	body, _ := json.Marshal(map[string]any{
		"key":      strings.TrimSpace(key),
		"validate": true,
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/api-key", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("invalid API key — check the key and try again")
	}

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render("API key saved successfully."))
	return nil
}

func authToken() error {
	var token string
	err := huh.NewInput().
		Title("Enter your Anthropic bearer token").
		Placeholder("sk-ant-oat01-...").
		EchoMode(huh.EchoModePassword).
		Value(&token).
		Run()
	if err != nil || strings.TrimSpace(token) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		return errSilent
	}

	body, _ := json.Marshal(map[string]any{
		"token": strings.TrimSpace(token),
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/token", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render("Token saved successfully."))
	return nil
}

func authOAuth(mode string) error {
	// Step 1: Get authorize URL
	body, _ := json.Marshal(map[string]string{"mode": mode})
	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/oauth/authorize", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	var authResp struct {
		URL      string `json:"url"`
		Verifier string `json:"verifier"`
		State    string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}
	if authResp.URL == "" || authResp.Verifier == "" {
		return fmt.Errorf("server returned empty authorize URL or verifier")
	}

	// Step 2: Open browser
	fmt.Println(styleBold.Render("Opening browser for authentication..."))
	if err := openBrowser(authResp.URL); err != nil {
		fmt.Println(styleDim.Render("Could not open browser. Open this URL manually:"))
		fmt.Println(authResp.URL)
	}
	fmt.Println()

	// Step 3: Prompt for callback code
	var callbackCode string
	err = huh.NewInput().
		Title("Paste the callback code from the browser").
		Placeholder("code#state").
		Value(&callbackCode).
		Run()
	if err != nil || strings.TrimSpace(callbackCode) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		return errSilent
	}

	// Step 4: Exchange
	exchangeBody, _ := json.Marshal(map[string]string{
		"callback_code": strings.TrimSpace(callbackCode),
		"verifier":      authResp.Verifier,
		"mode":          mode,
	})
	resp2, err := httpClient.Post(baseURL()+"/api/auth/anthropic/oauth/exchange", "application/json", bytes.NewReader(exchangeBody))
	if err != nil {
		return fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		return serverError(resp2)
	}

	var exchangeResp struct {
		OK      bool   `json:"ok"`
		Mode    string `json:"mode"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&exchangeResp); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}

	fmt.Println(styleOk.Render("Authentication successful!"))
	fmt.Println(styleDim.Render(exchangeResp.Message))
	return nil
}

// ── whatsapp auth flow ────────────────────────────────────────────────────────

func authWhatsApp() error {
	// Step 1: Ask phone mode
	var phoneMode string
	err := huh.NewSelect[string]().
		Title("WhatsApp phone mode").
		Description("How should the agent connect to WhatsApp?").
		Options(
			huh.NewOption("Use my number (talk to yourself, the agent replies in self-chat)", "self"),
			huh.NewOption("Give the agent its own number (uses a second phone/SIM)", "companion"),
		).
		Value(&phoneMode).
		Run()
	if err != nil {
		return errSilent
	}

	settings := map[string]any{"phoneMode": phoneMode}

	// Step 2: If companion, ask owner phone number
	if phoneMode == "companion" {
		var ownerPhone string
		err = huh.NewInput().
			Title("Your phone number (E.164 format)").
			Description("the agent will only respond to messages from this number").
			Placeholder("+1234567890").
			Value(&ownerPhone).
			Run()
		if err != nil || strings.TrimSpace(ownerPhone) == "" {
			fmt.Fprintln(os.Stderr, "Cancelled.")
			return errSilent
		}
		// Normalize: strip + and spaces, append @s.whatsapp.net
		normalized := strings.ReplaceAll(strings.TrimSpace(ownerPhone), " ", "")
		normalized = strings.TrimPrefix(normalized, "+")
		settings["ownerJid"] = normalized + "@s.whatsapp.net"
	}

	// Step 3: POST login/start (longer timeout — Baileys needs time to connect)
	fmt.Println(styleDim.Render("Connecting to WhatsApp..."))
	loginClient := &http.Client{Timeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]any{
		"accountId": "default",
		"settings":  settings,
	})
	resp, err := loginClient.Post(baseURL()+"/api/channels/whatsapp/login/start", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Failed to connect: "+err.Error()))
		waitForEnter()
		return errSilent
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, styleErr.Render("Server error: "+serverError(resp).Error()))
		waitForEnter()
		return errSilent
	}

	var loginResp struct {
		QR         string `json:"qr"`
		QRTerminal string `json:"qrTerminal"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&loginResp); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Invalid response: "+err.Error()))
		waitForEnter()
		return errSilent
	}

	// Step 4: Print QR in terminal (server renders it for us)
	if loginResp.QRTerminal != "" {
		fmt.Println()
		fmt.Println(styleBold.Render("Scan this QR code with WhatsApp on your phone:"))
		fmt.Print(loginResp.QRTerminal)
	} else if loginResp.QR != "" {
		fmt.Println()
		fmt.Println(styleBold.Render("Scan this QR code with WhatsApp on your phone:"))
		fmt.Println(styleDim.Render("(QR available but terminal rendering unavailable)"))
	} else {
		fmt.Println(styleDim.Render("Restoring existing session..."))
	}

	// Step 5: Long-poll login/wait (5.5 min — outlast the server's 5 min timeout)
	fmt.Println(styleDim.Render("Waiting for WhatsApp to connect..."))
	waitClient := &http.Client{Timeout: 330 * time.Second}
	waitBody, _ := json.Marshal(map[string]any{"accountId": "default"})
	resp2, err := waitClient.Post(baseURL()+"/api/channels/whatsapp/login/wait", "application/json", bytes.NewReader(waitBody))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Login timed out or failed: "+err.Error()))
		waitForEnter()
		return errSilent
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, styleErr.Render("Login failed: "+serverError(resp2).Error()))
		waitForEnter()
		return errSilent
	}

	fmt.Println()
	fmt.Println(styleOk.Render("WhatsApp connected! You're all set."))
	fmt.Println()
	waitForEnter()
	return errSilent
}

// ── channel helpers ───────────────────────────────────────────────────────────

func printChannelStatuses() error {
	resp, err := httpClient.Get(baseURL() + "/api/channels")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil // silently skip if not supported
	}

	var channels []struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
		Status      struct {
			State       string  `json:"state"`
			ConnectedAt float64 `json:"connectedAt,omitempty"`
			Error       string  `json:"error,omitempty"`
			Detail      string  `json:"detail,omitempty"`
		} `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&channels); err != nil {
		return nil
	}

	for _, ch := range channels {
		fmt.Println()
		fmt.Println(styleBold.Render("  " + ch.DisplayName))
		switch ch.Status.State {
		case "connected":
			t := time.UnixMilli(int64(ch.Status.ConnectedAt))
			fmt.Println("    Status:  ", styleOk.Render("Connected"))
			fmt.Println("    Since:   ", t.Format(time.RFC3339))
		case "connecting":
			detail := ch.Status.Detail
			if detail == "" {
				detail = "connecting..."
			}
			fmt.Println("    Status:  ", styleDim.Render(detail))
		case "error":
			fmt.Println("    Status:  ", styleErr.Render("Error: "+ch.Status.Error))
		default:
			fmt.Println("    Not configured")
		}
	}
	return nil
}

func clearChannel(name string, channelId string) error {
	body, _ := json.Marshal(map[string]any{"accountId": "default"})
	resp, err := httpClient.Post(baseURL()+"/api/channels/"+channelId+"/logout", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("cannot reach server at %s", baseURL())
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		fmt.Println("No " + name + " connection found.")
		return nil
	}

	if resp.StatusCode != 200 {
		return serverError(resp)
	}

	fmt.Println(styleOk.Render(name + " disconnected and credentials removed."))
	return nil
}
