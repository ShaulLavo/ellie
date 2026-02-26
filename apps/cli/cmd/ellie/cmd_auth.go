package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
)

// ── auth status ──────────────────────────────────────────────────────────────

func cmdAuthStatus() {
	url := baseURL() + "/api/auth/anthropic/status"
	resp, err := httpClient.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server at", baseURL())
		fmt.Fprintln(os.Stderr, styleDim.Render("  Make sure the server is running."))
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(body))
		os.Exit(1)
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
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Invalid response:", err)
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println(styleBold.Render("Auth Status"))
	fmt.Println(strings.Repeat("─", 40))

	if !status.Configured || status.Mode == nil {
		fmt.Println("  No credentials configured.")
		fmt.Println(styleDim.Render("  Run `ellie auth` to set up authentication."))
		fmt.Println()
		return
	}

	fmt.Println("  Mode:  ", *status.Mode)
	fmt.Println("  Source: ", status.Source)

	if status.Preview != nil {
		fmt.Println("  Key:   ", *status.Preview)
	}

	if status.ExpiresAt != nil {
		exp := time.UnixMilli(int64(*status.ExpiresAt))
		expStr := exp.Format(time.RFC3339)
		if status.Expired != nil && *status.Expired {
			expStr += " (EXPIRED)"
		}
		fmt.Println("  Expires:", expStr)
	}
	fmt.Println()
}

// ── auth clear ───────────────────────────────────────────────────────────────

func cmdAuthClear() {
	url := baseURL() + "/api/auth/anthropic/clear"
	resp, err := httpClient.Post(url, "application/json", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server at", baseURL())
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(body))
		os.Exit(1)
	}

	var result struct {
		Cleared bool `json:"cleared"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Invalid response:", err)
		os.Exit(1)
	}

	if result.Cleared {
		fmt.Println(styleOk.Render("Stored credentials removed."))
	} else {
		fmt.Println("No stored credentials found.")
	}
}

// ── auth (interactive wizard) ────────────────────────────────────────────────

func cmdAuth() {
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
		os.Exit(1)
	}

	switch method {
	case "api_key":
		authApiKey()
	case "oauth_max":
		authOAuth("max")
	case "oauth_console":
		authOAuth("console")
	case "token":
		authToken()
	}
}

func authApiKey() {
	var key string
	err := huh.NewInput().
		Title("Enter your Anthropic API key").
		Placeholder("sk-ant-...").
		EchoMode(huh.EchoModePassword).
		Value(&key).
		Run()
	if err != nil || strings.TrimSpace(key) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		os.Exit(1)
	}

	fmt.Println(styleDim.Render("Validating key..."))

	body, _ := json.Marshal(map[string]any{
		"key":      strings.TrimSpace(key),
		"validate": true,
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/api-key", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		fmt.Fprintln(os.Stderr, styleErr.Render("Invalid API key."), "Check the key and try again.")
		os.Exit(1)
	}

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(respBody))
		os.Exit(1)
	}

	fmt.Println(styleOk.Render("API key saved successfully."))
}

func authToken() {
	var token string
	err := huh.NewInput().
		Title("Enter your Anthropic bearer token").
		Placeholder("sk-ant-oat01-...").
		EchoMode(huh.EchoModePassword).
		Value(&token).
		Run()
	if err != nil || strings.TrimSpace(token) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		os.Exit(1)
	}

	body, _ := json.Marshal(map[string]any{
		"token": strings.TrimSpace(token),
	})

	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/token", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(respBody))
		os.Exit(1)
	}

	fmt.Println(styleOk.Render("Token saved successfully."))
}

func authOAuth(mode string) {
	// Step 1: Get authorize URL
	body, _ := json.Marshal(map[string]string{"mode": mode})
	resp, err := httpClient.Post(baseURL()+"/api/auth/anthropic/oauth/authorize", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(respBody))
		os.Exit(1)
	}

	var authResp struct {
		URL      string `json:"url"`
		Verifier string `json:"verifier"`
		// State is captured but not forwarded to the exchange endpoint.
		// Anthropic embeds the state in the callback code (code#state),
		// and server-side validation occurs during the token exchange.
		State string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Invalid response:", err)
		os.Exit(1)
	}
	if authResp.URL == "" || authResp.Verifier == "" {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Server returned empty authorize URL or verifier")
		os.Exit(1)
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
		os.Exit(1)
	}

	// Step 4: Exchange
	exchangeBody, _ := json.Marshal(map[string]string{
		"callback_code": strings.TrimSpace(callbackCode),
		"verifier":      authResp.Verifier,
		"mode":          mode,
	})
	resp2, err := httpClient.Post(baseURL()+"/api/auth/anthropic/oauth/exchange", "application/json", bytes.NewReader(exchangeBody))
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server:", err)
		os.Exit(1)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp2.Body)
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), string(respBody))
		os.Exit(1)
	}

	var exchangeResp struct {
		OK      bool   `json:"ok"`
		Mode    string `json:"mode"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&exchangeResp); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Invalid response:", err)
		os.Exit(1)
	}

	fmt.Println(styleOk.Render("Authentication successful!"))
	fmt.Println(styleDim.Render(exchangeResp.Message))
}
