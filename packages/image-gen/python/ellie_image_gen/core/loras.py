"""LoRA downloading, arch compatibility checking, and application."""

from __future__ import annotations

import os
from typing import Any

from .assets import download_file
from .errors import LoraMismatchError

# Arch tags embedded in common LoRA filenames for compatibility detection
_ARCH_HINTS = {
    "sd15": ["sd15", "sd1.5", "sd_1_5", "1.5"],
    "sdxl": ["sdxl", "xl"],
}


class LoRACache:
    """Tracks downloaded LoRA files. Does not cache state dicts in memory."""

    def __init__(self, models_dir: str) -> None:
        self.models_dir = models_dir

    def ensure_downloaded(self, lora: dict[str, Any], civitai_token: str | None = None,
                          emit_progress: Any = None) -> str:
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
        return download_file(url, dest, civitai_token, phase="lora",
                             label=lora.get("name", filename), emit_progress=emit_progress)


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
                pipeline_arch: str, civitai_token: str | None = None,
                emit_progress: Any = None, emit_error: Any = None) -> set[str]:
    """Load and fuse LoRA weights with separate UNet/CLIP strengths.
    Returns set of successfully applied LoRA names."""
    if not loras:
        return set()

    _progress = emit_progress or (lambda *a, **kw: None)
    _error = emit_error or (lambda *a, **kw: None)

    adapter_names = []
    unet_weights = []
    clip_weights = []
    applied = set()

    for i, lora in enumerate(loras):
        name = lora.get("name", f"lora_{i}")
        _progress("lora", f"Loading LoRA: {name}...")

        path = cache.ensure_downloaded(lora, civitai_token, emit_progress=emit_progress)
        adapter_name = f"lora_{i}"

        # Arch compatibility check
        warning = check_lora_arch_compatibility(name, path, pipeline_arch)
        if warning:
            _error(warning, phase="lora")

        try:
            pipe.load_lora_weights(path, adapter_name=adapter_name)
            adapter_names.append(adapter_name)
            unet_weights.append(lora.get("strengthModel", 1.0))
            clip_weights.append(lora.get("strengthClip", 1.0))
            applied.add(name)
        except Exception as e:
            _error(f"LoRA load failed for {name}: {e}", phase="lora")

    if adapter_names:
        # Apply separate UNet and text-encoder strengths via per-component fusing
        pipe.set_adapters(adapter_names, adapter_weights=unet_weights)

        has_different_clip = any(u != c for u, c in zip(unet_weights, clip_weights))
        if has_different_clip:
            pipe.fuse_lora(lora_scale=1.0, components=["unet"])
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

        _progress("lora", f"Fused {len(adapter_names)} LoRA(s)")

    return applied
