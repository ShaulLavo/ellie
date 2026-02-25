package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

const defaultBaseURL = "http://localhost:3000"

var (
	styleBold = lipgloss.NewStyle().Bold(true)
	styleOk   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00A66D"))
	styleErr  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#EF4444"))
	styleDim  = lipgloss.NewStyle().Foreground(lipgloss.Color("#A1A1AA"))
)

func baseURL() string {
	if u := os.Getenv("ELLIE_API_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return defaultBaseURL
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		os.Exit(1)
	}

	switch args[0] {
	case "auth":
		if len(args) >= 2 {
			switch args[1] {
			case "status":
				cmdAuthStatus()
			case "clear":
				cmdAuthClear()
			default:
				fmt.Fprintf(os.Stderr, "Unknown auth command: %s\n", args[1])
				printUsage()
				os.Exit(1)
			}
		} else {
			cmdAuth()
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", args[0])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(styleBold.Render("Usage:"))
	fmt.Println("  cli auth          Interactive authentication setup")
	fmt.Println("  cli auth status   Show current auth status")
	fmt.Println("  cli auth clear    Remove stored Anthropic credentials")
}

// ── auth status ──────────────────────────────────────────────────────────────

func cmdAuthStatus() {
	url := baseURL() + "/api/auth/anthropic/status"
	resp, err := http.Get(url)
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
		Mode      *string  `json:"mode"`
		Source    string   `json:"source"`
		Configured bool   `json:"configured"`
		ExpiresAt *float64 `json:"expires_at,omitempty"`
		Expired   *bool    `json:"expired,omitempty"`
		Preview   *string  `json:"preview,omitempty"`
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
		fmt.Println(styleDim.Render("  Run `cli auth` to set up authentication."))
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
	resp, err := http.Post(url, "application/json", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Cannot reach server at", baseURL())
		os.Exit(1)
	}
	defer resp.Body.Close()

	var result struct {
		Cleared bool `json:"cleared"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&result)

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

	resp, err := http.Post(baseURL()+"/api/auth/anthropic/api-key", "application/json", bytes.NewReader(body))
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
		Value(&token).
		Run()
	if err != nil || strings.TrimSpace(token) == "" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		os.Exit(1)
	}

	body, _ := json.Marshal(map[string]any{
		"token": strings.TrimSpace(token),
	})

	resp, err := http.Post(baseURL()+"/api/auth/anthropic/token", "application/json", bytes.NewReader(body))
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
	resp, err := http.Post(baseURL()+"/api/auth/anthropic/oauth/authorize", "application/json", bytes.NewReader(body))
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
	}
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "Invalid response:", err)
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
	resp2, err := http.Post(baseURL()+"/api/auth/anthropic/oauth/exchange", "application/json", bytes.NewReader(exchangeBody))
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
	_ = json.NewDecoder(resp2.Body).Decode(&exchangeResp)

	fmt.Println(styleOk.Render("Authentication successful!"))
	fmt.Println(styleDim.Render(exchangeResp.Message))
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
