use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::Json,
};
use log::info;
use serde::Serialize;
use std::time::Instant;

use crate::{
    audio_toolkit::{apply_custom_words, filter_transcription_output},
    engine::{lock_engine, TranscribeParams},
    pipeline::{decode_wav, run_vad_pipeline, PipelineConfig},
    AppState,
};

#[derive(Serialize)]
pub struct TranscribeResponse {
    pub text: String,
    pub duration_ms: u64,
    pub speech_detected: bool,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// POST /transcribe
///
/// Accepts multipart/form-data with:
///   - `audio` — WAV bytes (required)
///   - `params` — JSON-encoded TranscribeParams (optional)
pub async fn transcribe_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, (StatusCode, Json<ErrorResponse>)> {
    let start = Instant::now();

    let mut audio_bytes: Option<Vec<u8>> = None;
    let mut params = TranscribeParams::default();

    // Parse multipart fields
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })? {
        match field.name() {
            Some("audio") => {
                audio_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| {
                            (
                                StatusCode::BAD_REQUEST,
                                Json(ErrorResponse {
                                    error: e.to_string(),
                                }),
                            )
                        })?
                        .to_vec(),
                );
            }
            Some("params") => {
                let text = field.text().await.map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: e.to_string(),
                        }),
                    )
                })?;
                params = serde_json::from_str(&text).map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!("Invalid params JSON: {}", e),
                        }),
                    )
                })?;
            }
            _ => {}
        }
    }

    let audio_bytes = audio_bytes.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Missing 'audio' field".to_string(),
            }),
        )
    })?;

    // Decode WAV
    let (samples, source_rate) = decode_wav(&audio_bytes).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    // Run VAD pipeline (CPU-bound → spawn_blocking)
    let pipeline_cfg = PipelineConfig {
        vad_model_path: state.config.vad_model.to_string_lossy().to_string(),
        vad_threshold: state.config.vad_threshold,
        prefill: state.config.vad_prefill,
        hangover: state.config.vad_hangover,
        onset: state.config.vad_onset,
    };

    let speech = tokio::task::spawn_blocking(move || {
        run_vad_pipeline(samples, source_rate, &pipeline_cfg)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    if speech.is_empty() {
        return Ok(Json(TranscribeResponse {
            text: String::new(),
            duration_ms: start.elapsed().as_millis() as u64,
            speech_detected: false,
        }));
    }

    // Transcribe (CPU-bound → spawn_blocking)
    let engine_arc = state.engine.clone();
    let params_for_transcribe = params.clone();
    let raw_text = tokio::task::spawn_blocking(move || {
        let mut engine = lock_engine(&engine_arc);
        engine.transcribe(speech, &params_for_transcribe)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    // Apply text post-processing (matching Handy's pipeline)
    let threshold = params.word_correction_threshold.unwrap_or(0.5);
    let corrected = if let Some(ref words) = params.custom_words {
        if !words.is_empty() {
            apply_custom_words(&raw_text, words, threshold)
        } else {
            raw_text
        }
    } else {
        raw_text
    };

    let lang = params.filter_language.as_deref().unwrap_or("en");
    let filtered = filter_transcription_output(&corrected, lang, &params.custom_filler_words);

    let duration_ms = start.elapsed().as_millis() as u64;
    info!("Transcription completed in {}ms: {}", duration_ms, &filtered);

    Ok(Json(TranscribeResponse {
        text: filtered,
        duration_ms,
        speech_detected: true,
    }))
}
