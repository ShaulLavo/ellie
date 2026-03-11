"""ELLA cross-attention adapter for enhanced prompt comprehension (SD 1.5 only)."""

from __future__ import annotations

import os
from typing import Any

from .errors import EllaInvalidError


class ELLAAdapter:
    """
    ELLA cross-attention adapter that maps T5 embeddings into the UNet's
    cross-attention space via a trained linear projection.
    """

    def __init__(self, state_dict: dict[str, Any], cross_attention_dim: int,
                 device: str, dtype: Any) -> None:
        import torch
        import torch.nn as nn

        self.cross_attention_dim = cross_attention_dim

        # Detect the projection shape from state dict
        proj_weight = None
        for key, tensor in state_dict.items():
            if "weight" in key and tensor.dim() == 2:
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
            raise EllaInvalidError("Could not find projection weights in ELLA state dict")

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


def load_ella(pipe: Any, config: dict[str, Any], device: str, dtype: Any,
              emit_progress: Any = None) -> dict[str, Any]:
    """Load ELLA adapter + T5 encoder. Returns component dict with projection adapter."""
    _progress = emit_progress or (lambda *a, **kw: None)

    ella_model_path = config.get("ellaModelPath")
    t5_encoder_id = config.get("t5Encoder", "google/flan-t5-xl")
    t5_max_length = config.get("t5MaxLength", 128)

    if not ella_model_path:
        raise EllaInvalidError("ELLA model path not specified")

    # Download ELLA weights if needed
    if not os.path.exists(ella_model_path):
        ella_hf_repo = config.get("ellaHfRepo")
        ella_hf_filename = config.get("ellaHfFilename")
        if ella_hf_repo and ella_hf_filename:
            from huggingface_hub import hf_hub_download
            _progress("ella", "Downloading ELLA model...")
            ella_model_path = hf_hub_download(
                repo_id=ella_hf_repo,
                filename=ella_hf_filename,
                local_dir=str(os.path.dirname(ella_model_path)),
            )
        else:
            raise EllaInvalidError(f"ELLA model not found at {ella_model_path} and no HF repo specified")

    _progress("ella", "Loading T5 text encoder...")

    from transformers import T5EncoderModel, T5Tokenizer
    import torch

    t5_tokenizer = T5Tokenizer.from_pretrained(t5_encoder_id)
    t5_encoder = T5EncoderModel.from_pretrained(t5_encoder_id, torch_dtype=dtype).to(device)

    _progress("ella", "Loading ELLA adapter weights...")
    from safetensors.torch import load_file
    ella_state_dict = load_file(ella_model_path)

    cross_attention_dim = pipe.unet.config.cross_attention_dim

    _progress("ella", "Building ELLA projection adapter...")
    adapter = ELLAAdapter(ella_state_dict, cross_attention_dim, device, dtype)

    _progress("ella", "ELLA ready")

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

    projected = adapter.project(t5_embeds)
    return projected
