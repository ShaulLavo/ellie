"""Central domain exceptions for image generation.

Each exception carries a `code` (machine-readable), `message` (human-readable),
`phase` (which pipeline stage failed), and `retryable` flag.
"""

from __future__ import annotations


class ImageGenError(Exception):
    """Base exception for all image generation errors."""

    code: str = "UNKNOWN"
    phase: str | None = None
    retryable: bool = False

    def __init__(self, message: str, *, phase: str | None = None, retryable: bool | None = None):
        super().__init__(message)
        if phase is not None:
            self.phase = phase
        if retryable is not None:
            self.retryable = retryable

    def to_dict(self, request_id: str | None = None) -> dict:
        d: dict = {
            "code": self.code,
            "message": str(self),
            "retryable": self.retryable,
        }
        if self.phase:
            d["phase"] = self.phase
        if request_id:
            d["requestId"] = request_id
        return d


class ValidationError(ImageGenError):
    code = "VALIDATION_ERROR"
    phase = "validate"


class AssetDownloadError(ImageGenError):
    code = "ASSET_DOWNLOAD_FAILED"
    phase = "download"
    retryable = True


class ModelLoadError(ImageGenError):
    code = "MODEL_LOAD_FAILED"
    phase = "load"


class LoraMismatchError(ImageGenError):
    code = "LORA_MISMATCH"
    phase = "lora"


class EllaInvalidError(ImageGenError):
    code = "ELLA_INVALID"
    phase = "ella"


class OutOfMemoryError(ImageGenError):
    code = "OOM"
    retryable = True


class TimeoutError(ImageGenError):
    code = "TIMEOUT"
    retryable = True


class ADetailerError(ImageGenError):
    code = "ADETAILER_FAILED"
    phase = "adetailer"
    retryable = True


class ServiceBusyError(ImageGenError):
    code = "SERVICE_BUSY"
    retryable = True
