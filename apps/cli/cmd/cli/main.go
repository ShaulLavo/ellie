package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

const defaultBaseURL = "http://localhost:3000"

var (
	styleBold  = lipgloss.NewStyle().Bold(true)
	styleOk    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00A66D"))
	styleErr   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#EF4444"))
	styleDim   = lipgloss.NewStyle().Foreground(lipgloss.Color("#A1A1AA"))
	httpClient = &http.Client{Timeout: 10 * time.Second}
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
	case "dev":
		cmdDev()
	case "start":
		cmdStart()
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
	fmt.Println("  ellie dev             Start development server (hot reload)")
	fmt.Println("  ellie start           Run production server (requires build)")
	fmt.Println("  ellie auth            Interactive authentication setup")
	fmt.Println("  ellie auth status     Show current auth status")
	fmt.Println("  ellie auth clear      Remove stored Anthropic credentials")
}

// ── helpers ─────────────────────────────────────────────────────────────────

// findMonorepoRoot walks up from CWD looking for turbo.json.
// Supports ELLIE_ROOT env var override.
func findMonorepoRoot() (string, error) {
	if root := os.Getenv("ELLIE_ROOT"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "turbo.json")); err != nil {
			return "", fmt.Errorf("ELLIE_ROOT=%s does not contain turbo.json", root)
		}
		return root, nil
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("cannot determine working directory: %w", err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "turbo.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("cannot find monorepo root (looked for turbo.json). Set ELLIE_ROOT or run from within the project")
}

// findBin locates a binary on PATH or in the monorepo's node_modules/.bin.
func findBin(name string, root string) (string, error) {
	// Check PATH first
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}

	// Fall back to local node_modules/.bin
	local := filepath.Join(root, "node_modules", ".bin", name)
	if _, err := os.Stat(local); err == nil {
		return local, nil
	}

	return "", fmt.Errorf("%s not found in PATH or node_modules/.bin", name)
}

// runProcess spawns a child process, forwards signals, and returns its exit code.
func runProcess(name string, args []string, dir string) int {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		return 1
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		_ = cmd.Process.Signal(sig)
	}()

	err := cmd.Wait()
	signal.Stop(sigCh)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

// ── dev ─────────────────────────────────────────────────────────────────────

func cmdDev() {
	root, err := findMonorepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	turboPath, err := findBin("turbo", root)
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	fmt.Println(styleBold.Render("Starting dev server..."))
	fmt.Println()

	exitCode := runProcess(turboPath, []string{"run", "dev", "--filter=!cli"}, root)
	os.Exit(exitCode)
}

// ── start ───────────────────────────────────────────────────────────────────

func cmdStart() {
	root, err := findMonorepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), err)
		os.Exit(1)
	}

	binaryPath := filepath.Join(root, "dist", "server")
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, styleErr.Render("Error:"), "No production build found at dist/server. Build the project first.")
		os.Exit(1)
	}

	fmt.Println(styleBold.Render("Starting production server..."))
	fmt.Println()

	exitCode := runProcess(binaryPath, []string{}, root)
	os.Exit(exitCode)
}

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

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
