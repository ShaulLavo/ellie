"""Textual inversion embedding loading."""

from __future__ import annotations

import os
from typing import Any

from .assets import download_file


def load_textual_inversions(pipe: Any, inversions: list[dict[str, Any]],
                            civitai_token: str | None = None,
                            emit_progress: Any = None) -> None:
    """Download and load textual inversion embeddings."""
    _progress = emit_progress or (lambda *a, **kw: None)

    for ti in inversions:
        ti_path = ti.get("path")
        ti_token = ti.get("token")
        ti_url = ti.get("url")

        if ti_url and ti_path and not os.path.exists(ti_path):
            _progress("download", f"Downloading embedding: {ti_token}...")
            download_file(ti_url, ti_path, civitai_token, phase="download",
                          label=ti_token or "embedding", emit_progress=emit_progress)

        if ti_path and os.path.exists(ti_path) and ti_token:
            _progress("load", f"Loading embedding: {ti_token}...")
            pipe.load_textual_inversion(ti_path, token=ti_token)
        elif ti_path:
            _progress("load", f"Embedding not found: {ti_path}, skipping")
