use anyhow::{Context, Result};
use std::time::Duration;

use crate::audio_toolkit::{
    audio::FrameResampler,
    constants::WHISPER_SAMPLE_RATE,
    vad::{SileroVad, SmoothedVad, VadFrame, VoiceActivityDetector},
};

pub struct PipelineConfig {
    pub vad_model_path: String,
    pub vad_threshold: f32,
    pub prefill: usize,
    pub hangover: usize,
    pub onset: usize,
}

/// Decodes a WAV byte slice into (mono f32 samples, sample_rate).
/// Handles int and float formats, stereo → mono.
pub fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
    let cursor = std::io::Cursor::new(bytes);
    let mut reader = hound::WavReader::new(cursor).context("Failed to parse WAV header")?;

    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .step_by(channels)
            .map(|s| s.context("WAV sample read error"))
            .collect::<Result<Vec<_>>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .step_by(channels)
                .map(|s| s.context("WAV sample read error").map(|v| v as f32 / max))
                .collect::<Result<Vec<_>>>()?
        }
    };

    Ok((samples, sample_rate))
}

/// Runs the full pipeline: resample → VAD → collect speech frames.
///
/// Returns the concatenated speech frames as a `Vec<f32>` at 16 kHz.
/// Returns an empty Vec if no speech was detected.
pub fn run_vad_pipeline(samples: Vec<f32>, source_rate: u32, config: &PipelineConfig) -> Result<Vec<f32>> {
    let target_rate = WHISPER_SAMPLE_RATE as usize;
    let frame_dur = Duration::from_millis(30);

    let mut resampler = FrameResampler::new(source_rate as usize, target_rate, frame_dur);

    let silero = SileroVad::new(&config.vad_model_path, config.vad_threshold)?;
    let mut vad = SmoothedVad::new(
        Box::new(silero),
        config.prefill,
        config.hangover,
        config.onset,
    );

    let mut speech: Vec<f32> = Vec::new();

    // Feed all samples through resampler → VAD
    resampler.push(&samples, |frame| {
        if let Ok(vad_frame) = vad.push_frame(frame) {
            if let VadFrame::Speech(s) = vad_frame {
                speech.extend_from_slice(s);
            }
        }
    });

    // Flush remaining samples
    resampler.finish(|frame| {
        if let Ok(vad_frame) = vad.push_frame(frame) {
            if let VadFrame::Speech(s) = vad_frame {
                speech.extend_from_slice(s);
            }
        }
    });

    Ok(speech)
}
