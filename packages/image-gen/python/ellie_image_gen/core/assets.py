"""Asset downloading with progress reporting."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .errors import AssetDownloadError


def download_file(url: str, dest_path: str, civitai_token: str | None = None,
                  phase: str = "download", label: str = "model",
                  emit_progress: Any = None) -> str:
    """Download a file with progress. Returns local path."""
    import requests

    _progress = emit_progress or (lambda *a, **kw: None)

    dest = Path(dest_path)
    if dest.exists():
        _progress(phase, f"{label} (cached)")
        return str(dest)

    dest.parent.mkdir(parents=True, exist_ok=True)

    download_url = url
    if civitai_token and "civitai.com" in url:
        sep = "&" if "?" in url else "?"
        download_url = f"{url}{sep}token={civitai_token}"

    _progress(phase, f"{label}")

    try:
        resp = requests.get(download_url, stream=True, timeout=600)
        resp.raise_for_status()
    except Exception as e:
        raise AssetDownloadError(f"Failed to download {label}: {e}", phase=phase)

    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    chunk_size = 8 * 1024 * 1024

    def _fmt_size(b: int) -> str:
        if b < 1024 * 1024:
            return f"{b / 1024:.0f}KB"
        return f"{b / (1024 * 1024):.0f}MB"

    tmp_path = str(dest) + ".tmp"
    try:
        with open(tmp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    _progress(phase,
                              f"{label} — {_fmt_size(downloaded)} / {_fmt_size(total)}",
                              bytesDone=downloaded, bytesTotal=total)

        os.rename(tmp_path, str(dest))
    except AssetDownloadError:
        raise
    except Exception as e:
        # Clean up partial download
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise AssetDownloadError(f"Failed to save {label}: {e}", phase=phase)

    _progress(phase, f"{label} — done")
    return str(dest)
