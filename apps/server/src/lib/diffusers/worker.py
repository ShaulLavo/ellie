#!/usr/bin/env python3
"""
Persistent Diffusers worker process.

Communicates via JSONL on stdin/stdout. Owns model lifecycle, adapter caches,
scheduler resolution, ELLA conditioning, and image generation.

Protocol:
  → stdin:  one JSON object per line (requests)
  ← stdout: one JSON object per line (events)

Request types: init, generate, health, shutdown
Event types:   ready, progress, result, error, health, shutdown_ack
"""

from __future__ import annotations

import gc
import json
import os
import random
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

# ── JSONL output ─────────────────────────────────────────────────────────────

def emit(event: dict[str, Any]) -> None:
    """Write a single JSON line to stdout and flush."""
    print(json.dumps(event, default=str), flush=True)

def emit_progress(phase: str, message: str | None = None, **kwargs: Any) -> None:
    evt: dict[str, Any] = {"event": "progress", "phase": phase}
    if message:
        evt["message"] = message
    evt.update(kwargs)
    emit(evt)

def emit_error(message: str, phase: str | None = None) -> None:
    evt: dict[str, Any] = {"event": "error", "message": message}
    if phase:
        evt["phase"] = phase
    emit(evt)

def emit_result(**kwargs: Any) -> None:
    emit({"event": "result", "success": True, **kwargs})

# ── Scheduler registry ───────────────────────────────────────────────────────

SCHEDULER_REGISTRY: dict[str, tuple[str, dict[str, Any]]] = {
    "euler":              ("EulerDiscreteScheduler", {}),
    "euler_ancestral":    ("EulerAncestralDiscreteScheduler", {}),
    "heun":               ("HeunDiscreteScheduler", {}),
    "dpm_2":              ("KDPM2DiscreteScheduler", {}),
    "dpm_2_ancestral":    ("KDPM2AncestralDiscreteScheduler", {}),
    "dpmpp_2m":           ("DPMSolverMultistepScheduler", {}),
    "dpmpp_2m_sde":       ("DPMSolverMultistepScheduler", {"algorithm_type": "sde-dpmsolver++"}),
    "dpmpp_sde":          ("DPMSolverSDEScheduler", {}),
    "ddim":               ("DDIMScheduler", {}),
    "uni_pc":             ("UniPCMultistepScheduler", {}),
    "lms":                ("LMSDiscreteScheduler", {}),
    "dpmpp_2s_ancestral": ("DPMSolverSinglestepScheduler", {}),
}

def get_scheduler_class(name: str):
    """Import and return the scheduler class by name."""
    import diffusers
    return getattr(diffusers, name)

def apply_scheduler(pipe: Any, sampler: str, scheduler: str) -> None:
    """Configure the scheduler/sampler on a pipeline. Raises on unknown sampler."""
    entry = SCHEDULER_REGISTRY.get(sampler)
    if not entry:
        raise ValueError(f"Unknown sampler: {sampler}. Valid: {', '.join(SCHEDULER_REGISTRY.keys())}")

    class_name, extra_kwargs = entry
    SchedulerClass = get_scheduler_class(class_name)
    kwargs = dict(extra_kwargs)
    if scheduler == "karras":
        kwargs["use_karras_sigmas"] = True
    pipe.scheduler = SchedulerClass.from_config(pipe.scheduler.config, **kwargs)

# ── Device / dtype detection ─────────────────────────────────────────────────

class DeviceProfile:
    """Detected once per worker lifetime."""

    def __init__(self):
        import torch

        self.device: str
        self.dtype: Any
        self.vram_mb: int | None = None
        self.attention_backend: str = "default"

        if torch.cuda.is_available():
            self.device = "cuda"
            props = torch.cuda.get_device_properties(0)
            self.vram_mb = props.total_mem // (1024 * 1024)

            # dtype: bf16 on Ampere+, fp16 otherwise
            if props.major >= 8:
                self.dtype = torch.bfloat16
            else:
                self.dtype = torch.float16

            # Attention backend
            try:
                import xformers  # noqa: F401
                self.attention_backend = "xformers"
            except ImportError:
                if hasattr(torch.nn.functional, "scaled_dot_product_attention"):
                    self.attention_backend = "sdpa"

        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            self.device = "mps"
            self.dtype = torch.float32  # MPS fp16 is unreliable
        else:
            self.device = "cpu"
            self.dtype = torch.float32

    def to_dict(self) -> dict[str, Any]:
        import torch
        dtype_name = str(self.dtype).replace("torch.", "")
        return {
            "device": self.device,
            "dtype": dtype_name,
            "vramMb": self.vram_mb,
            "attentionBackend": self.attention_backend,
        }

# ── Model cache ──────────────────────────────────────────────────────────────

# Maximum number of pipelines to keep in memory.
# On model switch, the oldest pipeline is evicted to prevent OOM.
MAX_CACHED_PIPELINES = 1

class ModelCache:
    """Caches loaded pipelines keyed by model source + device + dtype."""

    def __init__(self, profile: DeviceProfile):
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

    def get_or_load(self, config: dict[str, Any]) -> Any:
        key = self._cache_key(config)
        if key in self._pipelines:
            pipe = self._pipelines[key]
            # Unfuse any previously fused LoRAs for a clean start
            self._clean_loras(key, pipe)
            emit_progress("load", "Using cached pipeline")
            return pipe

        # Evict if at capacity
        self._evict_if_needed()

        pipe = self._load_fresh(config)
        self._pipelines[key] = pipe
        self._load_order.append(key)
        self._lora_state[key] = set()
        return pipe

    def _evict_if_needed(self) -> None:
        """Evict oldest pipelines if at or over capacity."""
        import torch

        while len(self._pipelines) >= MAX_CACHED_PIPELINES and self._load_order:
            oldest_key = self._load_order.pop(0)
            pipe = self._pipelines.pop(oldest_key, None)
            self._lora_state.pop(oldest_key, None)
            if pipe is not None:
                emit_progress("load", f"Evicting cached pipeline to free memory")
                del pipe
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                gc.collect()

    def _load_fresh(self, config: dict[str, Any]) -> Any:
        import torch
        from diffusers import (
            StableDiffusionPipeline,
            StableDiffusionXLPipeline,
        )

        device = self.profile.device
        dtype = self.profile.dtype

        pipe_kwargs: dict[str, Any] = {
            "torch_dtype": dtype,
            "use_safetensors": True,
        }

        arch = config.get("arch", "sd15")
        PipeClass = StableDiffusionXLPipeline if arch == "sdxl" else StableDiffusionPipeline

        hf_model_id = config.get("hfModelId")
        single_file_path = config.get("singleFilePath")

        if single_file_path:
            emit_progress("load", "Loading model from safetensors file...", step=1, totalSteps=4)
            try:
                pipe = PipeClass.from_single_file(single_file_path, **pipe_kwargs)
            except Exception:
                # Fallback: try the other arch
                FallbackClass = StableDiffusionPipeline if arch == "sdxl" else StableDiffusionXLPipeline
                emit_progress("load", "Primary load failed, trying fallback...", step=1, totalSteps=4)
                pipe = FallbackClass.from_single_file(single_file_path, **pipe_kwargs)
        elif hf_model_id:
            emit_progress("load", f"Loading {hf_model_id}...", step=1, totalSteps=4)
            pipe = PipeClass.from_pretrained(hf_model_id, **pipe_kwargs)
        else:
            raise ValueError("No model source (need hfModelId or singleFilePath)")

        emit_progress("load", "Moving to device...", step=2, totalSteps=4)
        pipe = pipe.to(device)

        emit_progress("load", "Applying optimizations...", step=3, totalSteps=4)
        pipe.enable_attention_slicing()
        if hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()

        # CPU offload for limited VRAM
        if device == "cuda" and self.profile.vram_mb and self.profile.vram_mb < 8192:
            try:
                pipe.enable_model_cpu_offload()
            except Exception:
                pass

        emit_progress("load", "Pipeline ready", step=4, totalSteps=4)
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
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

    def cached_keys(self) -> list[str]:
        return list(self._pipelines.keys())

# ── Asset downloading ────────────────────────────────────────────────────────

def download_file(url: str, dest_path: str, civitai_token: str | None = None,
                  phase: str = "download", label: str = "model") -> str:
    """Download a file with progress. Returns local path."""
    import requests

    dest = Path(dest_path)
    if dest.exists():
        emit_progress(phase, f"{label} already cached at {dest.name}")
        return str(dest)

    dest.parent.mkdir(parents=True, exist_ok=True)

    download_url = url
    if civitai_token and "civitai.com" in url:
        sep = "&" if "?" in url else "?"
        download_url = f"{url}{sep}token={civitai_token}"

    emit_progress(phase, f"Downloading {label}...")

    resp = requests.get(download_url, stream=True, timeout=600)
    resp.raise_for_status()

    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    chunk_size = 8 * 1024 * 1024

    tmp_path = str(dest) + ".tmp"
    with open(tmp_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=chunk_size):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                emit_progress(phase,
                            f"Downloading {label}... {downloaded / (1024*1024):.0f}MB / {total / (1024*1024):.0f}MB",
                            bytesDone=downloaded, bytesTotal=total)

    os.rename(tmp_path, str(dest))
    emit_progress(phase, f"{label} downloaded: {dest.name}")
    return str(dest)

# ── LoRA handling ────────────────────────────────────────────────────────────

# Arch tags embedded in common LoRA filenames for compatibility detection
_ARCH_HINTS = {
    "sd15": ["sd15", "sd1.5", "sd_1_5", "1.5"],
    "sdxl": ["sdxl", "xl"],
}

class LoRACache:
    """Tracks downloaded LoRA files. Does not cache state dicts in memory."""

    def __init__(self, models_dir: str):
        self.models_dir = models_dir

    def ensure_downloaded(self, lora: dict[str, Any], civitai_token: str | None = None) -> str:
        """Return local path, downloading if needed."""
        path = lora.get("path")
        if path and os.path.exists(path):
            return path

        url = lora.get("url")
        if not url:
            filename = lora.get("filename", lora.get("name", "unknown"))
            path = os.path.join(self.models_dir, "loras", filename)
            if os.path.exists(path):
                return path
            raise ValueError(f"LoRA not found and no URL: {filename}")

        filename = lora.get("filename", f"lora_{lora.get('name', 'unknown')}.safetensors")
        dest = os.path.join(self.models_dir, "loras", filename)
        return download_file(url, dest, civitai_token, phase="lora", label=lora.get("name", filename))


def check_lora_arch_compatibility(lora_name: str, lora_path: str, pipeline_arch: str) -> str | None:
    """Check if a LoRA filename hints at arch incompatibility.
    Returns a warning message if mismatch detected, None if OK or unknown."""
    filename_lower = os.path.basename(lora_path).lower()

    for arch, hints in _ARCH_HINTS.items():
        if any(h in filename_lower for h in hints):
            if arch != pipeline_arch:
                return (f"LoRA '{lora_name}' appears to be for {arch} "
                        f"but pipeline is {pipeline_arch}. "
                        f"This may cause errors or degraded quality.")
            return None  # Matches — OK

    return None  # No arch hint in filename — assume compatible


def apply_loras(pipe: Any, loras: list[dict[str, Any]], cache: LoRACache,
                pipeline_arch: str, civitai_token: str | None = None) -> set[str]:
    """Load and fuse LoRA weights with separate UNet/CLIP strengths.
    Returns set of successfully applied LoRA names."""
    if not loras:
        return set()

    adapter_names = []
    unet_weights = []
    clip_weights = []
    applied = set()

    for i, lora in enumerate(loras):
        name = lora.get("name", f"lora_{i}")
        emit_progress("lora", f"Loading LoRA: {name}...")

        path = cache.ensure_downloaded(lora, civitai_token)
        adapter_name = f"lora_{i}"

        # Arch compatibility check
        warning = check_lora_arch_compatibility(name, path, pipeline_arch)
        if warning:
            emit_error(warning, phase="lora")

        try:
            pipe.load_lora_weights(path, adapter_name=adapter_name)
            adapter_names.append(adapter_name)
            unet_weights.append(lora.get("strengthModel", 1.0))
            clip_weights.append(lora.get("strengthClip", 1.0))
            applied.add(name)
        except Exception as e:
            emit_error(f"LoRA load failed for {name}: {e}", phase="lora")

    if adapter_names:
        # Apply separate UNet and text-encoder strengths via per-component fusing
        # First set adapters with UNet weights
        pipe.set_adapters(adapter_names, adapter_weights=unet_weights)

        # If UNet and CLIP weights differ, we need to fuse separately
        has_different_clip = any(u != c for u, c in zip(unet_weights, clip_weights))
        if has_different_clip:
            # Fuse UNet at UNet strength, then manually adjust text encoder
            pipe.fuse_lora(lora_scale=1.0, components=["unet"])
            # Now set text encoder weights and fuse
            pipe.set_adapters(adapter_names, adapter_weights=clip_weights)
            text_encoder_components = []
            if hasattr(pipe, "text_encoder"):
                text_encoder_components.append("text_encoder")
            if hasattr(pipe, "text_encoder_2"):
                text_encoder_components.append("text_encoder_2")
            if text_encoder_components:
                pipe.fuse_lora(lora_scale=1.0, components=text_encoder_components)
        else:
            pipe.fuse_lora()

        emit_progress("lora", f"Fused {len(adapter_names)} LoRA(s)")

    return applied

# ── Textual inversion handling ───────────────────────────────────────────────

def load_textual_inversions(pipe: Any, inversions: list[dict[str, Any]],
                            civitai_token: str | None = None) -> None:
    """Download and load textual inversion embeddings."""
    for ti in inversions:
        ti_path = ti.get("path")
        ti_token = ti.get("token")
        ti_url = ti.get("url")

        if ti_url and ti_path and not os.path.exists(ti_path):
            emit_progress("download", f"Downloading embedding: {ti_token}...")
            download_file(ti_url, ti_path, civitai_token, phase="download", label=ti_token or "embedding")

        if ti_path and os.path.exists(ti_path) and ti_token:
            emit_progress("load", f"Loading embedding: {ti_token}...")
            pipe.load_textual_inversion(ti_path, token=ti_token)
        elif ti_path:
            emit_progress("load", f"Embedding not found: {ti_path}, skipping")

# ── ELLA integration ─────────────────────────────────────────────────────────

class ELLAAdapter:
    """
    ELLA cross-attention adapter that maps T5 embeddings into the UNet's
    cross-attention space via a trained linear projection.

    The ELLA state dict contains projection weights that bridge the T5
    embedding dimension to the UNet's cross_attention_dim.
    """

    def __init__(self, state_dict: dict[str, Any], cross_attention_dim: int, device: str, dtype: Any):
        import torch
        import torch.nn as nn

        self.cross_attention_dim = cross_attention_dim

        # Detect the projection shape from state dict
        # ELLA state dicts typically have keys like 'connector.linear.weight'
        # or similar patterns mapping T5 dim -> UNet cross-attn dim
        proj_weight = None
        for key, tensor in state_dict.items():
            if "weight" in key and tensor.dim() == 2:
                # Find the projection matrix: should map to cross_attention_dim
                if tensor.shape[0] == cross_attention_dim or tensor.shape[1] == cross_attention_dim:
                    proj_weight = tensor
                    break

        if proj_weight is None:
            # Fallback: use the largest 2D tensor as the projection
            largest_2d = None
            for key, tensor in state_dict.items():
                if tensor.dim() == 2:
                    if largest_2d is None or tensor.numel() > largest_2d.numel():
                        largest_2d = tensor
            proj_weight = largest_2d

        if proj_weight is None:
            raise ValueError("Could not find projection weights in ELLA state dict")

        # Build projection: T5 dim -> cross_attention_dim
        t5_dim = proj_weight.shape[1] if proj_weight.shape[0] == cross_attention_dim else proj_weight.shape[0]
        self.projection = nn.Linear(t5_dim, cross_attention_dim, bias=False)

        # Load weights — transpose if needed so shape is [cross_attn_dim, t5_dim]
        if proj_weight.shape[0] == cross_attention_dim:
            self.projection.weight = nn.Parameter(proj_weight.to(dtype=dtype, device=device))
        else:
            self.projection.weight = nn.Parameter(proj_weight.T.to(dtype=dtype, device=device))

        self.projection = self.projection.to(device=device, dtype=dtype)

    def project(self, t5_embeds: Any) -> Any:
        """Project T5 embeddings into UNet cross-attention space."""
        import torch
        with torch.no_grad():
            return self.projection(t5_embeds)


def load_ella(pipe: Any, config: dict[str, Any], device: str, dtype: Any) -> dict[str, Any]:
    """Load ELLA adapter + T5 encoder. Returns component dict with projection adapter."""
    ella_model_path = config.get("ellaModelPath")
    t5_encoder_id = config.get("t5Encoder", "google/flan-t5-xl")
    t5_max_length = config.get("t5MaxLength", 128)

    if not ella_model_path:
        raise ValueError("ELLA model path not specified")

    # Download ELLA weights if needed
    if not os.path.exists(ella_model_path):
        ella_hf_repo = config.get("ellaHfRepo")
        ella_hf_filename = config.get("ellaHfFilename")
        if ella_hf_repo and ella_hf_filename:
            from huggingface_hub import hf_hub_download
            emit_progress("ella", "Downloading ELLA model...")
            ella_model_path = hf_hub_download(
                repo_id=ella_hf_repo,
                filename=ella_hf_filename,
                local_dir=str(Path(ella_model_path).parent),
            )
        else:
            raise ValueError(f"ELLA model not found at {ella_model_path} and no HF repo specified")

    emit_progress("ella", "Loading T5 text encoder...")

    from transformers import T5EncoderModel, T5Tokenizer
    import torch

    t5_tokenizer = T5Tokenizer.from_pretrained(t5_encoder_id)
    t5_encoder = T5EncoderModel.from_pretrained(t5_encoder_id, torch_dtype=dtype).to(device)

    emit_progress("ella", "Loading ELLA adapter weights...")
    from safetensors.torch import load_file
    ella_state_dict = load_file(ella_model_path)

    cross_attention_dim = pipe.unet.config.cross_attention_dim

    emit_progress("ella", "Building ELLA projection adapter...")
    adapter = ELLAAdapter(ella_state_dict, cross_attention_dim, device, dtype)

    emit_progress("ella", "ELLA ready")

    return {
        "t5_tokenizer": t5_tokenizer,
        "t5_encoder": t5_encoder,
        "adapter": adapter,
        "t5_max_length": t5_max_length,
    }


def encode_prompt_with_ella(ella_components: dict[str, Any], prompt: str,
                            device: str, dtype: Any) -> Any:
    """Encode prompt using T5, then project through ELLA adapter into UNet space."""
    import torch

    tokenizer = ella_components["t5_tokenizer"]
    encoder = ella_components["t5_encoder"]
    adapter = ella_components["adapter"]
    max_length = ella_components["t5_max_length"]

    tokens = tokenizer(
        prompt,
        max_length=max_length,
        padding="max_length",
        truncation=True,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        t5_embeds = encoder(**tokens).last_hidden_state

    # Project T5 embeddings through ELLA adapter to UNet cross-attention space
    projected = adapter.project(t5_embeds)
    return projected

# ── Generate command handler ─────────────────────────────────────────────────

def handle_generate(config: dict[str, Any], profile: DeviceProfile,
                    model_cache: ModelCache, lora_cache: LoRACache) -> None:
    """Handle a single generate request."""
    import torch

    models_dir = config.get("modelsDir", "")
    civitai_token = config.get("civitaiToken")
    pipeline_arch = config.get("arch", "sd15")

    # Download model checkpoint if needed
    single_file_url = config.get("singleFileUrl")
    single_file_path = config.get("singleFilePath")
    if single_file_url and not single_file_path:
        filename = config.get("singleFileFilename", "model.safetensors")
        dest = os.path.join(models_dir, "checkpoints", filename)
        single_file_path = download_file(single_file_url, dest, civitai_token)
        config["singleFilePath"] = single_file_path

    # Load pipeline (cached, with eviction)
    pipe = model_cache.get_or_load(config)

    # Set scheduler (raises on unknown sampler)
    apply_scheduler(pipe, config.get("sampler", "euler"), config.get("scheduler", "normal"))

    # Download + apply LoRAs with arch compatibility checks
    loras = config.get("loras", [])
    for lora in loras:
        if not lora.get("path"):
            lora["path"] = lora_cache.ensure_downloaded(lora, civitai_token)
    applied_loras = apply_loras(pipe, loras, lora_cache, pipeline_arch, civitai_token)
    cache_key = model_cache._cache_key(config)
    model_cache._lora_state[cache_key] = applied_loras

    # Load textual inversions
    load_textual_inversions(pipe, config.get("textualInversions", []), civitai_token)

    # ELLA (SD 1.5 only — validated at API boundary, but double-check here)
    use_ella = config.get("useElla", False)
    ella_components = None
    if use_ella:
        if pipeline_arch != "sd15":
            emit_error("ELLA is only supported on SD 1.5 pipelines", phase="ella")
            use_ella = False
        else:
            ella_components = load_ella(pipe, config, profile.device, profile.dtype)

    # Prepare generation
    seed = config.get("seed", -1)
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    generator = torch.Generator(device="cpu").manual_seed(seed)
    total_steps = config.get("steps", 25)

    def step_callback(pipe_obj, step, timestep, callback_kwargs):
        emit_progress("denoise", step=step + 1, totalSteps=total_steps)
        return callback_kwargs

    gen_kwargs: dict[str, Any] = {
        "prompt": config["prompt"],
        "negative_prompt": config.get("negativePrompt"),
        "width": config.get("width", 512),
        "height": config.get("height", 512),
        "num_inference_steps": total_steps,
        "guidance_scale": config.get("cfgScale", 7.0),
        "generator": generator,
        "num_images_per_prompt": config.get("batchSize", 1),
        "callback_on_step_end": step_callback,
    }

    # ELLA conditioning: project through adapter, not raw T5 injection
    if use_ella and ella_components:
        projected_embeds = encode_prompt_with_ella(
            ella_components, config["prompt"], profile.device, profile.dtype
        )
        gen_kwargs["prompt_embeds"] = projected_embeds
        del gen_kwargs["prompt"]

    emit_progress("denoise", "Starting generation...", step=0, totalSteps=total_steps)
    result = pipe(**gen_kwargs)

    # Save output
    emit_progress("save", "Encoding PNG...")
    output_path = config.get("outputPath")
    if not output_path:
        fd, output_path = tempfile.mkstemp(suffix=".png", prefix="gen-")
        os.close(fd)

    image = result.images[0]
    image.save(output_path, format="PNG")
    emit_progress("save", f"Saved to {output_path}")

    emit_result(
        imagePath=output_path,
        width=image.width,
        height=image.height,
        seed=seed,
    )

    # Cleanup ELLA (heavy — free T5 encoder after each gen)
    if ella_components:
        del ella_components
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

# ── Main event loop ──────────────────────────────────────────────────────────

def main() -> None:
    profile: DeviceProfile | None = None
    model_cache: ModelCache | None = None
    lora_cache: LoRACache | None = None
    start_time = time.monotonic()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            emit_error("Invalid JSON input")
            continue

        msg_type = msg.get("type", "")

        try:
            if msg_type == "init":
                import torch  # noqa: F811 — deferred import
                profile = DeviceProfile()
                models_dir = msg.get("modelsDir", "")
                model_cache = ModelCache(profile)
                lora_cache = LoRACache(models_dir)
                emit({
                    "event": "ready",
                    **profile.to_dict(),
                })

            elif msg_type == "generate":
                if not profile or not model_cache or not lora_cache:
                    emit_error("Worker not initialized. Send 'init' first.", phase="generate")
                    continue
                handle_generate(msg.get("config", {}), profile, model_cache, lora_cache)

            elif msg_type == "health":
                if not profile or not model_cache:
                    emit({"event": "health", "alive": True, "cachedModels": [], "uptimeMs": 0})
                else:
                    uptime = int((time.monotonic() - start_time) * 1000)
                    emit({
                        "event": "health",
                        "alive": True,
                        "cachedModels": model_cache.cached_keys(),
                        "uptimeMs": uptime,
                    })

            elif msg_type == "shutdown":
                if model_cache:
                    model_cache.evict_all()
                emit({"event": "shutdown_ack"})
                sys.exit(0)

            else:
                emit_error(f"Unknown message type: {msg_type}")

        except Exception as e:
            emit_error(f"{type(e).__name__}: {e}\n{traceback.format_exc()}", phase=msg_type)


if __name__ == "__main__":
    main()
