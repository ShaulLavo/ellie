package chatui

import (
	"strings"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/harmonica"
)

const (
	// 12 FPS is plenty for spring-driven dots.
	animFPS = 12

	// How many frames each dot stays "active" before passing to the next.
	animPhaseFrames = 7 // ~580ms per dot at 12 FPS

	// Ellipsis cycles every ~500ms.
	animEllipsisSpeed = 6
)

// Ellie TUI palette — matches view.go styles.
var (
	dotActiveStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#00A66D")) // teal (agent accent)
	dotRestStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#444"))    // very dim
	animLabelStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#888"))    // gray (toolCallStyle)
	animEllipStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#666"))    // dim gray
)

var animEllipsisFrames = []string{".", "..", "...", ""}

// animStepMsg triggers the next animation frame.
type animStepMsg struct{ id int }

// Global animation ID counter.
var animLastID int64

func animNextID() int {
	return int(atomic.AddInt64(&animLastID, 1))
}

// chatAnim is a minimal 3-dot bouncing spinner.
// Each dot is driven by a harmonica spring — the active dot springs to 1.0,
// the others spring back to 0.0, creating an organic wave.
type chatAnim struct {
	id    int
	label string
	step  int

	// Harmonica springs — one per dot.
	springs [3]harmonica.Spring
	pos     [3]float64
	vel     [3]float64

	// Which dot is currently targeted (0, 1, 2, cycles).
	activeDot    int
	phaseCounter int

	// Ellipsis animation.
	ellipsisStep int
}

// newChatAnim creates a new bouncing-dots spinner with the given label.
func newChatAnim(label string) *chatAnim {
	dt := harmonica.FPS(animFPS)
	a := &chatAnim{
		id:    animNextID(),
		label: label,
	}
	// Under-damped springs: quick response with a slight bounce.
	for i := range 3 {
		a.springs[i] = harmonica.NewSpring(dt, 6.0, 0.6)
	}
	return a
}

// start returns the initial tick command.
func (a *chatAnim) start() tea.Cmd {
	return a.tick()
}

// animate advances the animation by one step and returns the next tick.
func (a *chatAnim) animate(msg animStepMsg) tea.Cmd {
	if msg.id != a.id {
		return nil
	}

	a.step++

	// Advance phase: cycle which dot is "active".
	a.phaseCounter++
	if a.phaseCounter >= animPhaseFrames {
		a.phaseCounter = 0
		a.activeDot = (a.activeDot + 1) % 3
	}

	// Update springs: active dot targets 1.0, others target 0.0.
	for i := range 3 {
		target := 0.0
		if i == a.activeDot {
			target = 1.0
		}
		a.pos[i], a.vel[i] = a.springs[i].Update(a.pos[i], a.vel[i], target)
	}

	// Advance ellipsis.
	a.ellipsisStep++
	if a.ellipsisStep >= animEllipsisSpeed*len(animEllipsisFrames) {
		a.ellipsisStep = 0
	}

	return a.tick()
}

// render returns the current animation frame as a string.
func (a *chatAnim) render() string {
	var b strings.Builder

	// 3 dots with spring-driven state.
	for i := range 3 {
		if i > 0 {
			b.WriteRune(' ')
		}
		if a.pos[i] > 0.5 {
			b.WriteString(dotActiveStyle.Render("●"))
		} else {
			b.WriteString(dotRestStyle.Render("·"))
		}
	}

	// Label.
	if a.label != "" {
		b.WriteRune(' ')
		b.WriteString(animLabelStyle.Render(a.label))

		// Animated ellipsis.
		frameIdx := a.ellipsisStep / animEllipsisSpeed
		if frameIdx < len(animEllipsisFrames) {
			b.WriteString(animEllipStyle.Render(animEllipsisFrames[frameIdx]))
		}
	}

	return b.String()
}

// tick returns a tea.Cmd that sends an animStepMsg after the frame interval.
func (a *chatAnim) tick() tea.Cmd {
	id := a.id
	return tea.Tick(time.Second/time.Duration(animFPS), func(_ time.Time) tea.Msg {
		return animStepMsg{id: id}
	})
}
