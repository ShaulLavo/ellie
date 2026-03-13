"""Pipeline model cache with LRU eviction."""

from __future__ import annotations

import gc
from pathlib import Path
from typing import Any

from huggingface_hub import model_info

from .device import DeviceProfile


# Pipeline types that from_pretrained can load (have model_index.json).
_VALID_PIPELINE_TAGS = {"text-to-image", "image-to-image"}


def _validate_hf_model(model_id: str) -> None:
    """Check that a HF model ID is a diffusers pipeline before downloading."""
    try:
        info = model_info(model_id)
    except Exception as exc:
        raise ValueError(f"Cannot find model '{model_id}' on HuggingFace: {exc}") from exc

    tag = info.pipeline_tag or ""
    if tag and tag not in _VALID_PIPELINE_TAGS:
        raise ValueError(
            f"Model '{model_id}' is a '{tag}' model, not a diffusion pipeline. "
            f"Only {_VALID_PIPELINE_TAGS} models are supported."
        )

    siblings = {s.rfilename for s in (info.siblings or [])}
    if "model_index.json" not in siblings:
        raise ValueError(
            f"Model '{model_id}' is not a diffusers pipeline "
            f"(no model_index.json). It may be a ControlNet, VAE, or other component."
        )

# Maximum number of pipelines to keep in memory.
MAX_CACHED_PIPELINES = 1


class ModelCache:
    """Caches loaded pipelines keyed by model source + device + dtype."""

    def __init__(self, profile: DeviceProfile) -> None:
        self.profile = profile
        self._pipelines: dict[str, Any] = {}
        self._load_order: list[str] = []  # oldest first for LRU eviction
        self._lora_state: dict[str, set[str]] = {}  # pipe_key -> set of applied lora names

    def _cache_key(self, config: dict[str, Any]) -> str:
        hf = config.get("hfModelId", "")
        sf = config.get("singleFilePath", "")
        device = self.profile.device
        dtype = str(self.profile.dtype).replace("torch.", "")
        return f"{hf}|{sf}|{device}|{dtype}"

    def get_or_load(self, config: dict[str, Any], emit_progress: Any = None) -> Any:
        key = self._cache_key(config)
        if key in self._pipelines:
            pipe = self._pipelines[key]
            # Unfuse any previously fused LoRAs for a clean start
            self._clean_loras(key, pipe)
            if emit_progress:
                emit_progress("load", "Using cached pipeline")
            return pipe

        # Evict if at capacity
        self._evict_if_needed(emit_progress)

        pipe = self._load_fresh(config, emit_progress)
        self._pipelines[key] = pipe
        self._load_order.append(key)
        self._lora_state[key] = set()
        return pipe

    def _evict_if_needed(self, emit_progress: Any = None) -> None:
        """Evict oldest pipelines if at or over capacity."""
        import torch

        while len(self._pipelines) >= MAX_CACHED_PIPELINES and self._load_order:
            oldest_key = self._load_order.pop(0)
            pipe = self._pipelines.pop(oldest_key, None)
            self._lora_state.pop(oldest_key, None)
            if pipe is not None:
                if emit_progress:
                    emit_progress("load", "Evicting cached pipeline to free memory")
                del pipe
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                    torch.mps.empty_cache()

    def _load_fresh(self, config: dict[str, Any], emit_progress: Any = None) -> Any:
        import os
        import torch
        from diffusers import (
            StableDiffusionPipeline,
            StableDiffusionXLPipeline,
        )

        device = self.profile.device
        dtype = self.profile.dtype

        # Allow spilling into system RAM instead of hard-crashing on OOM
        if "PYTORCH_MPS_HIGH_WATERMARK_RATIO" not in os.environ:
            os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

        pipe_kwargs: dict[str, Any] = {
            "torch_dtype": dtype,
            "use_safetensors": True,
        }

        arch = config.get("arch", "sd15")
        PipeClass = StableDiffusionXLPipeline if arch == "sdxl" else StableDiffusionPipeline

        hf_model_id = config.get("hfModelId")
        single_file_path = config.get("singleFilePath")

        _progress = emit_progress or (lambda *a, **kw: None)

        if single_file_path:
            _progress("load", f"Loading {Path(single_file_path).name}", step=1, totalSteps=4)
            # Explicit config prevents from_single_file picking up wrong cached models
            config_repo = (
                "stabilityai/stable-diffusion-xl-base-1.0" if arch == "sdxl"
                else "sd-legacy/stable-diffusion-v1-5"
            )
            try:
                pipe = PipeClass.from_single_file(
                    single_file_path,
                    config=config_repo,
                    local_files_only=False,
                    **pipe_kwargs,
                )
            except Exception as exc:
                raise RuntimeError(
                    f"Failed to load {Path(single_file_path).name} as {PipeClass.__name__}: {exc}"
                ) from exc
        elif hf_model_id:
            _progress("load", f"Validating {hf_model_id}...", step=1, totalSteps=4)
            _validate_hf_model(hf_model_id)
            _progress("load", f"Loading {hf_model_id}...", step=1, totalSteps=4)
            pipe = PipeClass.from_pretrained(hf_model_id, **pipe_kwargs)
        else:
            raise ValueError("No model source (need hfModelId or singleFilePath)")

        _progress("load", "Preparing pipeline", step=2, totalSteps=4)
        pipe = pipe.to(device)

        _progress("load", "Optimizing", step=3, totalSteps=4)
        pipe.enable_attention_slicing()
        # VAE tiling only on CUDA — causes tile seam artifacts on MPS
        if device == "cuda" and hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()

        # CPU offload for limited VRAM
        if device == "cuda" and self.profile.vram_mb and self.profile.vram_mb < 8192:
            try:
                pipe.enable_model_cpu_offload()
            except Exception:
                pass

        _progress("load", "Pipeline ready", step=4, totalSteps=4)
        return pipe

    def _clean_loras(self, key: str, pipe: Any) -> None:
        """Remove previously applied LoRAs from the cached pipeline."""
        applied = self._lora_state.get(key, set())
        if applied:
            try:
                pipe.unfuse_lora()
                pipe.unload_lora_weights()
            except Exception:
                pass
            self._lora_state[key] = set()

    def evict_all(self) -> None:
        """Free all cached pipelines."""
        import torch

        self._pipelines.clear()
        self._load_order.clear()
        self._lora_state.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()

    def cached_keys(self) -> list[str]:
        return list(self._pipelines.keys())
