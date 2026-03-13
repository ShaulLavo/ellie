"""Device and dtype detection — resolved once per process lifetime."""

from __future__ import annotations

from typing import Any


class DeviceProfile:
    """Detected compute device, dtype, VRAM, and attention backend."""

    def __init__(self) -> None:
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
            self.dtype = torch.float32  # MPS fp16 produces black images on many models
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
