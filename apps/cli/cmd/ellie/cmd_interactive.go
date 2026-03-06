package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/creack/pty"
	"github.com/spf13/cobra"

	"ellie/apps/cli/internal/sysinfo"
)

// Commands that need full terminal control (own TUI).
// Everything else gets output captured into a viewport.
var execCommands = map[string]bool{
	"chat": true,
	"auth": true,
}

// inlineCommands run in-process and return output directly (no subprocess).
var inlineCommands = map[string]func() string{
	"sysinfo": func() string {
		info := sysinfo.Collect(nil)
		return sysinfo.Render(info, sysinfo.RenderOpts{})
	},
}

// ── state ───────────────────────────────────────────────────────────

type interactiveState int

const (
	stateMenu   interactiveState = iota
	stateOutput                  // viewing captured output in viewport
)

// ── messages ────────────────────────────────────────────────────────

type cmdDoneMsg struct{ err error }

type processStartedMsg struct {
	cmd   *exec.Cmd
	lines <-chan string
	done  <-chan error
}

type outputLineMsg string
type outputDoneMsg struct{ err error }
type inlineOutputMsg struct{ output string }

// ── model ───────────────────────────────────────────────────────────

type interactiveModel struct {
	commands []*cobra.Command
	cursor   int
	width    int
	height   int

	state       interactiveState
	outputTitle string
	outputLines []string
	outputDone  bool
	viewport    viewport.Model
	proc        *exec.Cmd
	procLines   <-chan string
	procDone    <-chan error
}

func newInteractiveModel(root *cobra.Command) interactiveModel {
	var cmds []*cobra.Command
	for _, c := range root.Commands() {
		if !c.Hidden {
			cmds = append(cmds, c)
		}
	}
	return interactiveModel{
		commands: cmds,
		viewport: viewport.New(),
	}
}

func (m interactiveModel) Init() tea.Cmd {
	return nil
}

// ── update ──────────────────────────────────────────────────────────

func (m interactiveModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.viewport.SetWidth(msg.Width)
		m.viewport.SetHeight(msg.Height - 4) // title + status + help
		return m, nil

	case cmdDoneMsg:
		m.state = stateMenu
		return m, nil

	case processStartedMsg:
		m.proc = msg.cmd
		m.procLines = msg.lines
		m.procDone = msg.done
		return m, nextOutputLine(msg.lines, msg.done)

	case outputLineMsg:
		m.outputLines = append(m.outputLines, string(msg))
		m.viewport.SetContent(strings.Join(m.outputLines, "\n"))
		m.viewport.GotoBottom()
		return m, nextOutputLine(m.procLines, m.procDone)

	case outputDoneMsg:
		m.outputDone = true
		m.proc = nil
		return m, nil

	case inlineOutputMsg:
		m.outputLines = strings.Split(msg.output, "\n")
		m.viewport.SetContent(msg.output)
		m.outputDone = true
		return m, nil

	case tea.KeyMsg:
		if m.state == stateOutput {
			return m.updateOutput(msg)
		}
		return m.updateMenu(msg)
	}
	return m, nil
}

func (m interactiveModel) updateMenu(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.commands)-1 {
			m.cursor++
		}
	case "enter":
		cmd := m.commands[m.cursor]
		if execCommands[cmd.Name()] {
			c := exec.Command(os.Args[0], cmd.Name())
			c.Env = os.Environ()
			return m, tea.ExecProcess(c, func(err error) tea.Msg {
				return cmdDoneMsg{err: err}
			})
		}
		// Capture output in viewport
		m.state = stateOutput
		m.outputTitle = cmd.Name()
		m.outputLines = nil
		m.outputDone = false
		m.viewport.SetContent("")
		m.viewport.GotoTop()
		// Use in-process handler if available (avoids subprocess + PTY overhead)
		if fn, ok := inlineCommands[cmd.Name()]; ok {
			return m, func() tea.Msg {
				return inlineOutputMsg{output: fn()}
			}
		}
		return m, startOutputProcess(cmd.Name())
	}
	return m, nil
}

func (m interactiveModel) updateOutput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		if m.proc != nil && m.proc.Process != nil {
			_ = m.proc.Process.Signal(syscall.SIGTERM)
		}
		m.state = stateMenu
		m.proc = nil
		return m, nil
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

// ── process helpers ─────────────────────────────────────────────────

func startOutputProcess(name string) tea.Cmd {
	return func() tea.Msg {
		cmd := exec.Command(os.Args[0], name)
		cmd.Env = append(os.Environ(), "FORCE_COLOR=1")

		// Use a PTY so the child process thinks it has a real terminal
		// and emits colors / interactive output.
		ptmx, err := pty.Start(cmd)
		if err != nil {
			return outputDoneMsg{err: err}
		}

		lines := make(chan string, 256)
		done := make(chan error, 1)

		go func() {
			scanner := bufio.NewScanner(ptmx)
			for scanner.Scan() {
				lines <- scanner.Text()
			}
			close(lines)
		}()

		go func() {
			done <- cmd.Wait()
			ptmx.Close()
		}()

		return processStartedMsg{cmd: cmd, lines: lines, done: done}
	}
}

func nextOutputLine(lines <-chan string, done <-chan error) tea.Cmd {
	return func() tea.Msg {
		line, ok := <-lines
		if !ok {
			err := <-done
			return outputDoneMsg{err: err}
		}
		return outputLineMsg(line)
	}
}

// ── styles ──────────────────────────────────────────────────────────

var (
	menuTitle = lipgloss.NewStyle().Bold(true).
			Foreground(lipgloss.Color("#00A66D")).
			PaddingLeft(2).PaddingBottom(1)
	menuSelected = lipgloss.NewStyle().Bold(true).
			Foreground(lipgloss.Color("#00A66D"))
	menuNormal = lipgloss.NewStyle()
	menuHelp   = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A1A1AA")).
			PaddingLeft(2).PaddingTop(1)
	outputTitleStyle = lipgloss.NewStyle().Bold(true).
				Background(lipgloss.Color("#00A66D")).
				Foreground(lipgloss.Color("#000000")).
				Padding(0, 1)
)

// ── view ────────────────────────────────────────────────────────────

func (m interactiveModel) View() tea.View {
	var content string
	switch m.state {
	case stateOutput:
		content = m.renderOutput()
	default:
		content = m.renderMenu()
	}
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

func (m interactiveModel) renderMenu() string {
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString(menuTitle.Render("Ellie"))
	b.WriteString("\n")

	for i, cmd := range m.commands {
		cursor := "  "
		nameStyle := menuNormal
		if i == m.cursor {
			cursor = "▸ "
			nameStyle = menuSelected
		}
		name := nameStyle.Render(fmt.Sprintf("%-10s", cmd.Name()))
		desc := styleDim.Render(cmd.Short)
		b.WriteString(fmt.Sprintf("  %s%s %s\n", cursor, name, desc))
	}

	b.WriteString(menuHelp.Render("↑/↓ navigate • enter select • q quit"))
	b.WriteString("\n")

	return b.String()
}

func (m interactiveModel) renderOutput() string {
	var b strings.Builder

	title := outputTitleStyle.Render(m.outputTitle)
	status := styleDim.Render(" running…")
	if m.outputDone {
		status = styleDim.Render(" done")
	}
	b.WriteString(title + status + "\n\n")

	b.WriteString(m.viewport.View())

	help := "↑/↓ scroll • esc back"
	if !m.outputDone {
		help = "↑/↓ scroll • esc stop & back"
	}
	b.WriteString("\n" + styleDim.Render(help))

	return b.String()
}
