use axum::{extract::State, response::Json};
use serde::Serialize;

use crate::engine::lock_engine;
use crate::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub model_loaded: bool,
}

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let engine = lock_engine(&state.engine);
    Json(HealthResponse {
        status: "ok",
        model_loaded: engine.is_loaded(),
    })
}
