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

func cmdAuthStatus() error {
	fmt.Println()
	fmt.Println(styleBold.Render("Auth Status"))
	fmt.Println(strings.Repeat("─", 40))

	if err := printProviderStatus("Anthropic", "/api/auth/anthropic/status"); err != nil {
		return err
	}
	if err := printProviderStatus("Groq", "/api/auth/groq/status"); err != nil {
		return err
	}

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
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(body))
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

func cmdAuthClear() error {
	var target string
	err := huh.NewSelect[string]().
		Title("Which provider credentials should be cleared?").
		Options(
			huh.NewOption("Anthropic", "anthropic"),
			huh.NewOption("Groq", "groq"),
			huh.NewOption("All providers", "all"),
		).
		Value(&target).
		Run()
	if err != nil {
		return errSilent
	}

	switch target {
	case "anthropic":
		return clearProvider("Anthropic", "/api/auth/anthropic/clear")
	case "groq":
		return clearProvider("Groq", "/api/auth/groq/clear")
	case "all":
		if err := clearProvider("Anthropic", "/api/auth/anthropic/clear"); err != nil {
			return err
		}
		return clearProvider("Groq", "/api/auth/groq/clear")
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
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(body))
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

// ── auth (interactive wizard) ────────────────────────────────────────────────

func cmdAuth() error {
	var provider string
	err := huh.NewSelect[string]().
		Title("Choose a provider to authenticate").
		Options(
			huh.NewOption("Anthropic", "anthropic"),
			huh.NewOption("Groq", "groq"),
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
	}
	return nil
}

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
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(respBody))
	}

	fmt.Println(styleOk.Render("Groq API key saved successfully."))
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
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(respBody))
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
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(respBody))
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
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s", string(respBody))
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
		respBody, _ := io.ReadAll(resp2.Body)
		return fmt.Errorf("%s", string(respBody))
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
