package chatui

import (
	"strings"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// SpinnerDefinition defines a set of animation frames and their interval.
type SpinnerDefinition struct {
	Frames   []string
	Interval time.Duration
}

// Built-in spinner definitions.
var (
	SpinnerDots = SpinnerDefinition{
		Interval: 80 * time.Millisecond,
		Frames:   []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
	}
	SpinnerLine = SpinnerDefinition{
		Interval: 130 * time.Millisecond,
		Frames:   []string{"-", "\\", "|", "/"},
	}
	SpinnerArc = SpinnerDefinition{
		Interval: 100 * time.Millisecond,
		Frames:   []string{"◜", "◠", "◝", "◞", "◡", "◟"},
	}
	SpinnerBouncingBar = SpinnerDefinition{
		Interval: 80 * time.Millisecond,
		Frames: []string{
			"[    ]", "[=   ]", "[==  ]", "[=== ]",
			"[ ===]", "[  ==]", "[   =]", "[    ]",
			"[   =]", "[  ==]", "[ ===]", "[====]",
			"[=== ]", "[==  ]", "[=   ]",
		},
	}
)

// Default spinner used for all animations.
var defaultSpinner = SpinnerDots

// Ellipsis cycles every ~500ms worth of frames.
const animEllipsisSpeed = 6

// Spinner styles — sourced from shared palette.
var (
	spinnerFrameStyle = lipgloss.NewStyle().Foreground(colorAccent)
	animLabelStyle    = lipgloss.NewStyle().Foreground(colorMuted)
	animEllipStyle    = lipgloss.NewStyle().Foreground(colorDim)
)

var animEllipsisFrames = []string{".", "..", "...", ""}

// animStepMsg triggers the next animation frame.
type animStepMsg struct{ id int }

// Global animation ID counter.
var animLastID int64

func animNextID() int {
	return int(atomic.AddInt64(&animLastID, 1))
}

// chatAnim is a frame-cycling spinner with a label and animated ellipsis.
type chatAnim struct {
	id      int
	label   string
	spinner SpinnerDefinition

	frameIndex   int
	ellipsisStep int
}

// newChatAnim creates a new spinner with the given label using the default spinner.
func newChatAnim(label string) *chatAnim {
	return &chatAnim{
		id:      animNextID(),
		label:   label,
		spinner: defaultSpinner,
	}
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

	// Advance frame.
	a.frameIndex = (a.frameIndex + 1) % len(a.spinner.Frames)

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

	// Current spinner frame.
	frame := a.spinner.Frames[a.frameIndex]
	b.WriteString(spinnerFrameStyle.Render(frame))

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

// tick returns a tea.Cmd that sends an animStepMsg after the spinner interval.
func (a *chatAnim) tick() tea.Cmd {
	id := a.id
	return tea.Tick(a.spinner.Interval, func(_ time.Time) tea.Msg {
		return animStepMsg{id: id}
	})
}
