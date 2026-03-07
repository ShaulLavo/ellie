mod audio_toolkit;
mod config;
mod engine;
mod pipeline;
mod routes;

use std::sync::{Arc, Mutex};

use axum::{
    routing::{get, post},
    Router,
};
use clap::Parser;

use config::Config;
use engine::EngineState;

/// Shared Axum application state — cheap to clone (Arc inside).
#[derive(Clone)]
pub struct AppState {
    pub engine: engine::SharedEngine,
    pub config: Arc<Config>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init();

    let config = Config::parse();
    log::info!("Starting stt-server on {}:{}", config.host, config.port);
    log::info!("Models dir: {}", config.models_dir.display());
    log::info!("VAD model:  {}", config.vad_model.display());

    // Validate paths at startup
    if !config.vad_model.exists() {
        anyhow::bail!("VAD model not found: {}", config.vad_model.display());
    }
    if !config.models_dir.exists() {
        anyhow::bail!(
            "Models directory not found: {}",
            config.models_dir.display()
        );
    }

    let engine_state = Arc::new(Mutex::new(EngineState::new()));

    // Auto-load model if configured
    if let (Some(model_filename), Some(engine_kind_str)) =
        (&config.auto_load_model, &config.auto_load_engine)
    {
        let model_path = config.models_dir.join(model_filename);
        if !model_path.exists() {
            log::warn!(
                "Auto-load model not found: {} — skipping",
                model_path.display()
            );
        } else {
            let kind: engine::EngineKind = serde_json::from_str(&format!("\"{}\"", engine_kind_str))
                .unwrap_or_else(|_| {
                    log::error!("Invalid engine kind '{}', defaulting to whisper", engine_kind_str);
                    engine::EngineKind::Whisper
                });
            log::info!("Auto-loading model {:?} from {}", kind, model_path.display());
            let mut eng = engine_state.lock().unwrap();
            if let Err(e) = eng.load(model_path, kind) {
                log::error!("Failed to auto-load model: {}", e);
            } else {
                log::info!("Model auto-loaded successfully");
            }
        }
    }

    let state = AppState {
        engine: engine_state,
        config: Arc::new(config.clone()),
    };

    let app = Router::new()
        .route("/health", get(routes::health::health))
        .route("/transcribe", post(routes::transcribe::transcribe_handler))
        .route("/models", get(routes::models::list_models))
        .route("/models/load", post(routes::models::load_model))
        .route("/models/unload", post(routes::models::unload_model))
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let addr: std::net::SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    log::info!("Listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
