package chatui

import (
	"math"
	"strings"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/harmonica"
)

// SpinnerDefinition defines a set of animation frames and their interval.
type SpinnerDefinition struct {
	Frames   []string
	Interval time.Duration
}

// Built-in frame-based spinner definitions.
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

// Default spinner used for frame-based animations.
var defaultSpinner = SpinnerDots

// AnimMode selects between frame-cycling and spring-physics animation.
type AnimMode int

const (
	AnimFrames AnimMode = iota
	AnimSpring
)

// DefaultAnimMode controls which animation style newChatAnim uses.
var DefaultAnimMode = AnimFrames

// animEllipsisTarget is the desired duration for each ellipsis phase.
const animEllipsisTarget = 500 * time.Millisecond

// Spring bar constants.
const (
	springFPS      = 30
	springBarWidth = 10
	springNumDots  = 3
)

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

// Spring bar rendering constants.
var springBarChars = []string{"·", "∘", "○", "●"}

// springDot is a single spring-driven particle in the bar.
type springDot struct {
	pos    float64
	vel    float64
	target float64
	spring harmonica.Spring
}

// chatAnim is a spinner with a label and animated ellipsis.
// It supports two modes: frame-cycling (AnimFrames) and spring-physics (AnimSpring).
type chatAnim struct {
	id    int
	label string
	mode  AnimMode

	// Frame-based state.
	spinner    SpinnerDefinition
	frameIndex int

	// Spring-based state.
	dots         []springDot
	elapsed      float64
	intensityBuf [springBarWidth]float64

	// Shared.
	ellipsisStep  int
	ellipsisSpeed int // ticks per ellipsis phase, derived from tick interval
}

// newChatAnim creates a spinner using the DefaultAnimMode.
func newChatAnim(label string) *chatAnim {
	if DefaultAnimMode == AnimSpring {
		return newSpringChatAnim(label)
	}
	return newFrameChatAnim(label)
}

// newFrameChatAnim creates a frame-cycling spinner.
func newFrameChatAnim(label string) *chatAnim {
	sp := defaultSpinner
	speed := int(animEllipsisTarget / sp.Interval)
	if speed < 1 {
		speed = 1
	}
	return &chatAnim{
		id:            animNextID(),
		label:         label,
		mode:          AnimFrames,
		spinner:       sp,
		ellipsisSpeed: speed,
	}
}

// newSpringChatAnim creates a spring-physics bar spinner.
func newSpringChatAnim(label string) *chatAnim {
	dt := harmonica.FPS(springFPS)
	interval := time.Second / time.Duration(springFPS)
	speed := int(animEllipsisTarget / interval)
	if speed < 1 {
		speed = 1
	}
	a := &chatAnim{
		id:            animNextID(),
		label:         label,
		mode:          AnimSpring,
		ellipsisSpeed: speed,
	}
	for i := range springNumDots {
		freq := 5.0 + float64(i)*1.5
		damp := 0.2 + float64(i)*0.05
		offset := float64(i) / float64(springNumDots)
		a.dots = append(a.dots, springDot{
			pos:    offset * float64(springBarWidth),
			spring: harmonica.NewSpring(dt, freq, damp),
		})
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

	switch a.mode {
	case AnimFrames:
		a.frameIndex = (a.frameIndex + 1) % len(a.spinner.Frames)
	case AnimSpring:
		a.elapsed += 1.0 / float64(springFPS)
		for i := range a.dots {
			phase := float64(i) * 0.4
			t := (math.Sin(a.elapsed*2.1+phase)*0.5 + 0.5) * float64(springBarWidth-1)
			t += math.Sin(a.elapsed*5.3+phase*2.0) * 1.5
			a.dots[i].target = clampF(t, 0, float64(springBarWidth-1))
			a.dots[i].pos, a.dots[i].vel = a.dots[i].spring.Update(
				a.dots[i].pos, a.dots[i].vel, a.dots[i].target,
			)
		}
	}

	// Advance ellipsis.
	a.ellipsisStep++
	if a.ellipsisStep >= a.ellipsisSpeed*len(animEllipsisFrames) {
		a.ellipsisStep = 0
	}

	return a.tick()
}

// render returns the current animation frame as a string.
func (a *chatAnim) render() string {
	var b strings.Builder

	switch a.mode {
	case AnimFrames:
		b.WriteString(spinnerFrameStyle.Render(a.spinner.Frames[a.frameIndex]))
	case AnimSpring:
		b.WriteString(a.renderSpringBar())
	}

	// Label.
	if a.label != "" {
		b.WriteRune(' ')
		b.WriteString(animLabelStyle.Render(a.label))

		// Animated ellipsis.
		frameIdx := a.ellipsisStep / a.ellipsisSpeed
		if frameIdx < len(animEllipsisFrames) {
			b.WriteString(animEllipStyle.Render(animEllipsisFrames[frameIdx]))
		}
	}

	return b.String()
}

// renderSpringBar renders the spring-physics bar as an intensity-mapped string.
func (a *chatAnim) renderSpringBar() string {
	// Zero the reusable intensity buffer.
	a.intensityBuf = [springBarWidth]float64{}

	// Build intensity map from dot positions.
	for _, d := range a.dots {
		pos := clampF(d.pos, 0, float64(springBarWidth-1))
		idx := int(math.Round(pos))
		speed := math.Abs(d.vel)
		energy := math.Min(1.0, 0.3+speed*0.05)
		for delta := -2; delta <= 2; delta++ {
			j := idx + delta
			if j >= 0 && j < springBarWidth {
				falloff := 1.0 - float64(absI(delta))*0.35
				if falloff < 0 {
					falloff = 0
				}
				a.intensityBuf[j] = math.Max(a.intensityBuf[j], energy*falloff)
			}
		}
	}

	var b strings.Builder
	for i := range springBarWidth {
		v := a.intensityBuf[i]
		ci := int(v * float64(len(springBarChars)-1))
		if ci >= len(springBarChars) {
			ci = len(springBarChars) - 1
		}
		ch := springBarChars[ci]
		if v > 0.6 {
			b.WriteString(spinnerFrameStyle.Render(ch))
		} else if v > 0.2 {
			b.WriteString(animLabelStyle.Render(ch))
		} else {
			b.WriteString(animEllipStyle.Render(ch))
		}
	}
	return b.String()
}

// tick returns a tea.Cmd that sends an animStepMsg after the appropriate interval.
func (a *chatAnim) tick() tea.Cmd {
	id := a.id
	var interval time.Duration
	if a.mode == AnimSpring {
		interval = time.Second / time.Duration(springFPS)
	} else {
		interval = a.spinner.Interval
	}
	return tea.Tick(interval, func(_ time.Time) tea.Msg {
		return animStepMsg{id: id}
	})
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func absI(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
