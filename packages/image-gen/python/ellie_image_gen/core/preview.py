"""TAESD-based latent preview for live generation progress."""

from __future__ import annotations

import base64
import io
from typing import Any

# Cache TAESD instances by arch to avoid reloading
_taesd_cache: dict[str, Any] = {}


def load_taesd(arch: str, device: str, dtype: Any) -> Any | None:
    """Load the tiny autoencoder for the given architecture. Returns None on failure."""
    if arch in _taesd_cache:
        return _taesd_cache[arch]

    try:
        from diffusers import AutoencoderTiny

        model_id = "madebyollin/taesdxl" if arch == "sdxl" else "madebyollin/taesd"
        taesd = AutoencoderTiny.from_pretrained(model_id, torch_dtype=dtype)
        taesd = taesd.to(device)
        taesd.eval()
        _taesd_cache[arch] = taesd
        return taesd
    except Exception as e:
        print(f"[preview] Failed to load TAESD for {arch}: {e}")
        _taesd_cache[arch] = None
        return None


def decode_latents_preview(taesd: Any, latents: Any) -> str | None:
    """Decode latents with TAESD and return a base64-encoded JPEG string.

    Keeps the full output resolution (matching final image) for a clear preview.
    """
    import torch
    from PIL import Image

    try:
        with torch.no_grad():
            decoded = taesd.decode(latents).sample

        # TAESD output is in [-1, 1] range — remap to [0, 1]
        img_tensor = ((decoded[0] + 1.0) / 2.0).clamp(0, 1)
        img_array = (img_tensor.permute(1, 2, 0).cpu().float().numpy() * 255).astype("uint8")
        img = Image.fromarray(img_array)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as e:
        print(f"[preview] Failed to decode preview: {e}")
        return None
