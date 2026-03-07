use anyhow::{anyhow, Result};
use log::{debug, error, warn};
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use transcribe_rs::{
    engines::{
        gigaam::GigaAMEngine,
        moonshine::{
            ModelVariant, MoonshineEngine, MoonshineModelParams, MoonshineStreamingEngine,
            StreamingModelParams,
        },
        parakeet::{
            ParakeetEngine, ParakeetInferenceParams, ParakeetModelParams, TimestampGranularity,
        },
        sense_voice::{
            Language as SenseVoiceLanguage, SenseVoiceEngine, SenseVoiceInferenceParams,
            SenseVoiceModelParams,
        },
        whisper::{WhisperEngine, WhisperInferenceParams},
    },
    TranscriptionEngine,
};

/// Engine variant tag — sent over the API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Whisper,
    Parakeet,
    Moonshine,
    MoonshineStreaming,
    SenseVoice,
    GigaAm,
}

/// Parameters the caller can pass with each transcription request.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct TranscribeParams {
    pub language: Option<String>,
    pub translate: Option<bool>,
    pub custom_words: Option<Vec<String>>,
    pub custom_filler_words: Option<Vec<String>>,
    pub word_correction_threshold: Option<f64>,
    pub filter_language: Option<String>,
}

// -- internal engine wrapper (mirrors Handy's LoadedEngine enum) --

enum LoadedEngine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetEngine),
    Moonshine(MoonshineEngine),
    MoonshineStreaming(MoonshineStreamingEngine),
    SenseVoice(SenseVoiceEngine),
    GigaAM(GigaAMEngine),
}

impl LoadedEngine {
    fn kind(&self) -> EngineKind {
        match self {
            LoadedEngine::Whisper(_) => EngineKind::Whisper,
            LoadedEngine::Parakeet(_) => EngineKind::Parakeet,
            LoadedEngine::Moonshine(_) => EngineKind::Moonshine,
            LoadedEngine::MoonshineStreaming(_) => EngineKind::MoonshineStreaming,
            LoadedEngine::SenseVoice(_) => EngineKind::SenseVoice,
            LoadedEngine::GigaAM(_) => EngineKind::GigaAm,
        }
    }

    fn unload(&mut self) {
        match self {
            LoadedEngine::Whisper(e) => e.unload_model(),
            LoadedEngine::Parakeet(e) => e.unload_model(),
            LoadedEngine::Moonshine(e) => e.unload_model(),
            LoadedEngine::MoonshineStreaming(e) => e.unload_model(),
            LoadedEngine::SenseVoice(e) => e.unload_model(),
            LoadedEngine::GigaAM(e) => e.unload_model(),
        }
    }
}

/// Holds the loaded engine + metadata. Protected by `Arc<Mutex<_>>`.
pub struct EngineState {
    engine: Option<LoadedEngine>,
    pub model_path: Option<PathBuf>,
    pub kind: Option<EngineKind>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            engine: None,
            model_path: None,
            kind: None,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.engine.is_some()
    }

    /// Load a model from disk. Mirrors Handy's `TranscriptionManager::load_model`.
    pub fn load(&mut self, path: PathBuf, kind: EngineKind) -> Result<()> {
        let load_start = std::time::Instant::now();
        debug!("Loading model {:?} from {}", kind, path.display());

        // Unload any existing model first
        self.unload();

        let loaded = match kind {
            EngineKind::Whisper => {
                let mut e = WhisperEngine::new();
                e.load_model(&path)
                    .map_err(|e| anyhow!("Failed to load whisper model: {}", e))?;
                LoadedEngine::Whisper(e)
            }
            EngineKind::Parakeet => {
                let mut e = ParakeetEngine::new();
                e.load_model_with_params(&path, ParakeetModelParams::int8())
                    .map_err(|e| anyhow!("Failed to load parakeet model: {}", e))?;
                LoadedEngine::Parakeet(e)
            }
            EngineKind::Moonshine => {
                let mut e = MoonshineEngine::new();
                e.load_model_with_params(&path, MoonshineModelParams::variant(ModelVariant::Base))
                    .map_err(|e| anyhow!("Failed to load moonshine model: {}", e))?;
                LoadedEngine::Moonshine(e)
            }
            EngineKind::MoonshineStreaming => {
                let mut e = MoonshineStreamingEngine::new();
                e.load_model_with_params(&path, StreamingModelParams::default())
                    .map_err(|e| anyhow!("Failed to load moonshine streaming model: {}", e))?;
                LoadedEngine::MoonshineStreaming(e)
            }
            EngineKind::SenseVoice => {
                let mut e = SenseVoiceEngine::new();
                e.load_model_with_params(&path, SenseVoiceModelParams::int8())
                    .map_err(|e| anyhow!("Failed to load sensevoice model: {}", e))?;
                LoadedEngine::SenseVoice(e)
            }
            EngineKind::GigaAm => {
                let mut e = GigaAMEngine::new();
                e.load_model(&path)
                    .map_err(|e| anyhow!("Failed to load gigaam model: {}", e))?;
                LoadedEngine::GigaAM(e)
            }
        };

        self.kind = Some(loaded.kind());
        self.model_path = Some(path);
        self.engine = Some(loaded);

        debug!(
            "Model loaded in {}ms",
            load_start.elapsed().as_millis()
        );
        Ok(())
    }

    pub fn unload(&mut self) {
        if let Some(ref mut e) = self.engine {
            e.unload();
        }
        self.engine = None;
        self.model_path = None;
        self.kind = None;
    }

    /// Transcribe audio samples. Mirrors Handy's `TranscriptionManager::transcribe`.
    ///
    /// Uses catch_unwind to recover from engine panics without poisoning the mutex.
    pub fn transcribe(&mut self, audio: Vec<f32>, params: &TranscribeParams) -> Result<String> {
        let engine = match self.engine.take() {
            Some(e) => e,
            None => return Err(anyhow!("No model loaded")),
        };

        let transcribe_result = catch_unwind(AssertUnwindSafe(|| {
            Self::do_transcribe(engine, audio, params)
        }));

        match transcribe_result {
            Ok((mut engine, result)) => {
                // Success — put engine back
                self.engine = Some(engine);
                result
            }
            Err(panic_payload) => {
                // Engine panicked — do NOT put it back (unknown state)
                let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic".to_string()
                };
                error!(
                    "Transcription engine panicked: {}. Model has been unloaded.",
                    panic_msg
                );
                self.model_path = None;
                self.kind = None;
                Err(anyhow!(
                    "Transcription engine panicked: {}. Model unloaded.",
                    panic_msg
                ))
            }
        }
    }

    /// Inner transcription logic — runs the appropriate engine.
    /// Returns the engine back so it can be put back into the state.
    fn do_transcribe(
        mut engine: LoadedEngine,
        audio: Vec<f32>,
        params: &TranscribeParams,
    ) -> (LoadedEngine, Result<String>) {
        let result = match &mut engine {
            LoadedEngine::Whisper(e) => {
                let lang = params
                    .language
                    .as_deref()
                    .filter(|l| *l != "auto")
                    .map(|l| {
                        // Normalize Chinese variants like Handy does
                        if l == "zh-Hans" || l == "zh-Hant" {
                            "zh".to_string()
                        } else {
                            l.to_string()
                        }
                    });
                let p = WhisperInferenceParams {
                    language: lang,
                    translate: params.translate.unwrap_or(false),
                    ..Default::default()
                };
                e.transcribe_samples(audio, Some(p))
                    .map(|r| r.text)
                    .map_err(|e| anyhow!("Whisper transcription failed: {}", e))
            }
            LoadedEngine::Parakeet(e) => {
                let p = ParakeetInferenceParams {
                    timestamp_granularity: TimestampGranularity::Segment,
                    ..Default::default()
                };
                e.transcribe_samples(audio, Some(p))
                    .map(|r| r.text)
                    .map_err(|e| anyhow!("Parakeet transcription failed: {}", e))
            }
            LoadedEngine::Moonshine(e) => e
                .transcribe_samples(audio, None)
                .map(|r| r.text)
                .map_err(|e| anyhow!("Moonshine transcription failed: {}", e)),
            LoadedEngine::MoonshineStreaming(e) => e
                .transcribe_samples(audio, None)
                .map(|r| r.text)
                .map_err(|e| anyhow!("Moonshine streaming transcription failed: {}", e)),
            LoadedEngine::SenseVoice(e) => {
                let language = match params.language.as_deref().unwrap_or("auto") {
                    "zh" | "zh-Hans" | "zh-Hant" => SenseVoiceLanguage::Chinese,
                    "en" => SenseVoiceLanguage::English,
                    "ja" => SenseVoiceLanguage::Japanese,
                    "ko" => SenseVoiceLanguage::Korean,
                    "yue" => SenseVoiceLanguage::Cantonese,
                    _ => SenseVoiceLanguage::Auto,
                };
                let p = SenseVoiceInferenceParams {
                    language,
                    use_itn: true,
                };
                e.transcribe_samples(audio, Some(p))
                    .map(|r| r.text)
                    .map_err(|e| anyhow!("SenseVoice transcription failed: {}", e))
            }
            LoadedEngine::GigaAM(e) => e
                .transcribe_samples(audio, None)
                .map(|r| r.text)
                .map_err(|e| anyhow!("GigaAM transcription failed: {}", e)),
        };
        (engine, result)
    }
}

/// Lock helper that recovers from poisoned mutexes (matches Handy's pattern).
pub fn lock_engine(engine: &Mutex<EngineState>) -> MutexGuard<'_, EngineState> {
    engine.lock().unwrap_or_else(|poisoned| {
        warn!("Engine mutex was poisoned by a previous panic, recovering");
        poisoned.into_inner()
    })
}

/// The shared state type alias used across all route handlers.
pub type SharedEngine = Arc<Mutex<EngineState>>;
