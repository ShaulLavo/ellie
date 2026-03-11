"""FastAPI routes for image generation service."""

from __future__ import annotations

import asyncio
import json
import time
import traceback
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..core.cache import ModelCache
from ..core.device import DeviceProfile
from ..core.errors import ServiceBusyError, ValidationError
from ..core.loras import LoRACache

router = APIRouter()

# ── Singleton state ──────────────────────────────────────────────────────────

_profile: DeviceProfile | None = None
_model_cache: ModelCache | None = None
_lora_cache: LoRACache | None = None
_start_time: float = time.monotonic()
_busy: bool = False


def _ensure_initialized(models_dir: str) -> tuple[DeviceProfile, ModelCache, LoRACache]:
    """Lazy-init device profile and caches on first request."""
    global _profile, _model_cache, _lora_cache
    if _profile is None:
        _profile = DeviceProfile()
        _model_cache = ModelCache(_profile)
        _lora_cache = LoRACache(models_dir)
    return _profile, _model_cache, _lora_cache  # type: ignore[return-value]


# ── Request models ───────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    """Resolved generation config — mirrors @ellie/schemas ResolvedGenerationConfig."""
    prompt: str
    negativePrompt: str | None = None
    arch: str = "sd15"
    seed: int = -1
    steps: int = 25
    cfgScale: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    width: int = 512
    height: int = 512
    batchSize: int = 1
    useElla: bool = False
    ellaModel: str | None = None
    t5Encoder: str | None = None
    t5MaxLength: int | None = None
    modelsDir: str = ""
    # Model source
    hfModelId: str | None = None
    singleFileUrl: str | None = None
    singleFileFilename: str | None = None
    singleFilePath: str | None = None
    # Credentials
    civitaiToken: str | None = None
    # LoRAs
    loras: list[dict[str, Any]] = Field(default_factory=list)
    # Textual inversions
    textualInversions: list[dict[str, Any]] = Field(default_factory=list)
    # ELLA
    ellaModelPath: str | None = None
    ellaHfRepo: str | None = None
    ellaHfFilename: str | None = None


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/health")
async def health() -> dict[str, Any]:
    uptime_ms = int((time.monotonic() - _start_time) * 1000)
    device_info = _profile.to_dict() if _profile else {}
    cached_models = _model_cache.cached_keys() if _model_cache else []
    return {
        "status": "ok",
        "uptimeMs": uptime_ms,
        "device": device_info,
        "cachedModels": cached_models,
        "busy": _busy,
    }


@router.post("/generate/stream")
async def generate_stream(req: GenerateRequest, request: Request) -> StreamingResponse:
    global _busy

    if _busy:
        raise ServiceBusyError("A generation is already in progress")

    if not req.prompt:
        raise ValidationError("prompt is required")

    _busy = True
    request_id = getattr(request.state, "request_id", None)

    async def event_stream():
        global _busy
        try:
            config = req.model_dump()
            profile, model_cache, lora_cache = _ensure_initialized(config.get("modelsDir", ""))

            # Run generation in a thread to avoid blocking the event loop
            from ..core.engine import handle_generate

            progress_queue: asyncio.Queue[str] = asyncio.Queue()

            def emit_progress(phase: str, message: str | None = None, **kwargs: Any) -> None:
                evt: dict[str, Any] = {"event": "progress", "phase": phase}
                if message:
                    evt["message"] = message
                evt.update(kwargs)
                progress_queue.put_nowait(json.dumps(evt) + "\n")

            def emit_error(message: str, phase: str | None = None) -> None:
                evt: dict[str, Any] = {"event": "error", "message": message}
                if phase:
                    evt["phase"] = phase
                progress_queue.put_nowait(json.dumps(evt) + "\n")

            loop = asyncio.get_event_loop()

            # Run the blocking generation in a thread
            gen_future = loop.run_in_executor(
                None,
                lambda: handle_generate(config, profile, model_cache, lora_cache,
                                        emit_progress=emit_progress, emit_error=emit_error)
            )

            # Yield progress events as they come in
            while not gen_future.done():
                try:
                    line = await asyncio.wait_for(progress_queue.get(), timeout=0.1)
                    yield line
                except asyncio.TimeoutError:
                    continue

            # Drain any remaining progress events
            while not progress_queue.empty():
                yield progress_queue.get_nowait()

            # Get the result
            result_data = gen_future.result()
            result_event = {"event": "result", "success": True, **result_data}
            yield json.dumps(result_event) + "\n"

        except ServiceBusyError:
            raise
        except Exception as e:
            error_event: dict[str, Any] = {
                "event": "error",
                "code": getattr(e, "code", "INTERNAL_ERROR"),
                "message": str(e),
                "retryable": getattr(e, "retryable", False),
            }
            if hasattr(e, "phase") and e.phase:
                error_event["phase"] = e.phase
            if request_id:
                error_event["requestId"] = request_id
            yield json.dumps(error_event) + "\n"
        finally:
            _busy = False

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@router.get("/models")
async def list_models() -> dict[str, Any]:
    cached = _model_cache.cached_keys() if _model_cache else []
    return {"cachedModels": cached}


@router.post("/models/evict")
async def evict_models() -> dict[str, Any]:
    if _model_cache:
        _model_cache.evict_all()
    return {"evicted": True}
