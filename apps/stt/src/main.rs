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

    let state = AppState {
        engine: Arc::new(Mutex::new(EngineState::new())),
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
