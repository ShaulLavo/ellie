package chatui

import (
	"bytes"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/gopxl/beep/v2"
	"github.com/gopxl/beep/v2/mp3"
	"github.com/gopxl/beep/v2/speaker"
	"github.com/gopxl/beep/v2/vorbis"
	"github.com/gopxl/beep/v2/wav"
)

// audioPlayer is a singleton that manages audio playback via beep/speaker.
type audioPlayer struct {
	mu        sync.Mutex
	playing   bool
	ctrl      *beep.Ctrl
	uploadID  string
	speakerOn bool
}

var player audioPlayer

// audioPlayMsg requests playback of an audio part.
type audioPlayMsg struct {
	UploadID string
}

// audioStopMsg requests stopping current playback.
type audioStopMsg struct{}

// audioStateMsg reports playback state changes (completion or error).
type audioStateMsg struct {
	UploadID string
	Done     bool
	Err      error
}

// Play stops any current playback, decodes the audio data by MIME type,
// and starts playing through the speaker. onDone is called when playback
// finishes or is stopped.
func (p *audioPlayer) Play(data []byte, mime string, uploadID string, onDone func()) error {
	p.Stop()

	streamer, format, err := decodeAudio(data, mime)
	if err != nil {
		return err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Initialize or re-initialize the speaker at the correct sample rate.
	if !p.speakerOn {
		err := speaker.Init(format.SampleRate, format.SampleRate.N(time.Second/10))
		if err != nil {
			return fmt.Errorf("speaker init: %w", err)
		}
		p.speakerOn = true
	} else {
		// Resample if needed to match speaker sample rate.
		// For simplicity, re-init the speaker each time.
		speaker.Clear()
		err := speaker.Init(format.SampleRate, format.SampleRate.N(time.Second/10))
		if err != nil {
			return fmt.Errorf("speaker re-init: %w", err)
		}
	}

	ctrl := &beep.Ctrl{Streamer: streamer, Paused: false}
	p.ctrl = ctrl
	p.uploadID = uploadID
	p.playing = true

	speaker.Play(beep.Seq(ctrl, beep.Callback(func() {
		p.mu.Lock()
		if p.uploadID == uploadID {
			p.playing = false
			p.ctrl = nil
			p.uploadID = ""
		}
		p.mu.Unlock()
		if onDone != nil {
			onDone()
		}
	})))

	return nil
}

// Stop stops the currently playing audio.
func (p *audioPlayer) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.ctrl != nil {
		speaker.Clear()
		p.ctrl = nil
	}
	p.playing = false
	p.uploadID = ""
}

// IsPlaying returns true if the given uploadID is currently playing.
func (p *audioPlayer) IsPlaying(uploadID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.playing && p.uploadID == uploadID
}

// PlayingID returns the upload ID of the currently playing audio, or "".
func (p *audioPlayer) PlayingID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.playing {
		return p.uploadID
	}
	return ""
}

// decodeAudio decodes audio bytes based on MIME type into a beep streamer.
func decodeAudio(data []byte, mime string) (beep.StreamSeekCloser, beep.Format, error) {
	r := io.NopCloser(bytes.NewReader(data))

	switch mime {
	case "audio/ogg", "audio/vorbis", "audio/ogg; codecs=vorbis":
		return vorbis.Decode(r)
	case "audio/mpeg", "audio/mp3":
		return mp3.Decode(r)
	case "audio/wav", "audio/wave", "audio/x-wav":
		return wav.Decode(r)
	default:
		// Try ogg first (most common from TTS), fall back to mp3.
		s, f, err := vorbis.Decode(r)
		if err == nil {
			return s, f, nil
		}
		r = io.NopCloser(bytes.NewReader(data))
		return mp3.Decode(r)
	}
}
