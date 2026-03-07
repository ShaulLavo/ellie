use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
};
use serde::{Deserialize, Serialize};
use std::fs;

use crate::engine::{lock_engine, EngineKind};
use crate::AppState;

#[derive(Serialize)]
pub struct ModelEntry {
    pub filename: String,
    pub is_directory: bool,
    pub loaded: bool,
}

#[derive(Serialize)]
pub struct ModelsResponse {
    pub models: Vec<ModelEntry>,
    pub loaded_engine: Option<EngineKind>,
}

/// GET /models — list model files found in models_dir.
pub async fn list_models(State(state): State<AppState>) -> Json<ModelsResponse> {
    let engine = lock_engine(&state.engine);
    let loaded_path = engine.model_path.clone();
    let loaded_kind = engine.kind.clone();
    drop(engine);

    let entries = fs::read_dir(&state.config.models_dir)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    // Skip hidden files and partial downloads
                    !name.starts_with('.') && !name.ends_with(".part")
                })
                .map(|e| {
                    let fname = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let is_loaded = loaded_path
                        .as_ref()
                        .map(|p| p.ends_with(&fname))
                        .unwrap_or(false);
                    ModelEntry {
                        filename: fname,
                        is_directory: is_dir,
                        loaded: is_loaded,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Json(ModelsResponse {
        models: entries,
        loaded_engine: loaded_kind,
    })
}

#[derive(Deserialize)]
pub struct LoadRequest {
    pub filename: String,
    pub engine: EngineKind,
}

/// POST /models/load — load a model file into memory.
pub async fn load_model(
    State(state): State<AppState>,
    Json(req): Json<LoadRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let model_path = state.config.models_dir.join(&req.filename);
    if !model_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Model not found: {}", req.filename)
            })),
        ));
    }

    let engine_arc = state.engine.clone();
    let kind = req.engine;
    tokio::task::spawn_blocking(move || {
        let mut engine = lock_engine(&engine_arc);
        engine.load(model_path, kind)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    Ok(StatusCode::OK)
}

/// POST /models/unload — release the currently loaded model.
pub async fn unload_model(State(state): State<AppState>) -> StatusCode {
    let mut engine = lock_engine(&state.engine);
    engine.unload();
    StatusCode::OK
}
