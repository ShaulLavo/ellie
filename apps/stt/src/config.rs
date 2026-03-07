use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
#[command(name = "stt-server", about = "Speech-to-text HTTP server")]
pub struct Config {
    /// TCP port to listen on
    #[arg(long, env = "STT_PORT", default_value = "3456")]
    pub port: u16,

    /// Host/IP to bind
    #[arg(long, env = "STT_HOST", default_value = "127.0.0.1")]
    pub host: String,

    /// Directory where model files (.bin / directories) live
    #[arg(long, env = "STT_MODELS_DIR")]
    pub models_dir: PathBuf,

    /// Path to silero_vad_v4.onnx
    #[arg(long, env = "STT_VAD_MODEL")]
    pub vad_model: PathBuf,

    /// VAD threshold (0.0–1.0)
    #[arg(long, env = "STT_VAD_THRESHOLD", default_value = "0.3")]
    pub vad_threshold: f32,

    /// VAD prefill frames (30ms each)
    #[arg(long, env = "STT_VAD_PREFILL", default_value = "15")]
    pub vad_prefill: usize,

    /// VAD hangover frames
    #[arg(long, env = "STT_VAD_HANGOVER", default_value = "15")]
    pub vad_hangover: usize,

    /// VAD onset frames
    #[arg(long, env = "STT_VAD_ONSET", default_value = "2")]
    pub vad_onset: usize,

    /// Auto-load this model filename on startup (e.g. "parakeet-tdt-0.6b-v3-int8")
    #[arg(long, env = "STT_AUTO_LOAD_MODEL")]
    pub auto_load_model: Option<String>,

    /// Engine kind for auto-loaded model (e.g. "parakeet", "whisper", "moonshine")
    #[arg(long, env = "STT_AUTO_LOAD_ENGINE")]
    pub auto_load_engine: Option<String>,
}
