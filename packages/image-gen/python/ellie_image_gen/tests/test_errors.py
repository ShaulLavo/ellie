"""Tests for domain error types."""

import unittest

from ellie_image_gen.core.errors import (
    ImageGenError,
    ValidationError,
    AssetDownloadError,
    ModelLoadError,
    LoraMismatchError,
    EllaInvalidError,
    OutOfMemoryError,
    ServiceBusyError,
)


class TestErrorCodes(unittest.TestCase):
    """Verify each error type has a distinct code and correct defaults."""

    def test_validation_error(self):
        e = ValidationError("bad prompt")
        self.assertEqual(e.code, "VALIDATION_ERROR")
        self.assertEqual(e.phase, "validate")
        self.assertFalse(e.retryable)

    def test_asset_download_error(self):
        e = AssetDownloadError("404 not found")
        self.assertEqual(e.code, "ASSET_DOWNLOAD_FAILED")
        self.assertTrue(e.retryable)

    def test_model_load_error(self):
        e = ModelLoadError("corrupted file")
        self.assertEqual(e.code, "MODEL_LOAD_FAILED")
        self.assertFalse(e.retryable)

    def test_lora_mismatch_error(self):
        e = LoraMismatchError("wrong arch")
        self.assertEqual(e.code, "LORA_MISMATCH")
        self.assertEqual(e.phase, "lora")

    def test_ella_invalid_error(self):
        e = EllaInvalidError("sdxl not supported")
        self.assertEqual(e.code, "ELLA_INVALID")
        self.assertEqual(e.phase, "ella")

    def test_oom_error(self):
        e = OutOfMemoryError("CUDA OOM")
        self.assertEqual(e.code, "OOM")
        self.assertTrue(e.retryable)

    def test_service_busy_error(self):
        e = ServiceBusyError("generation in progress")
        self.assertEqual(e.code, "SERVICE_BUSY")
        self.assertTrue(e.retryable)

    def test_to_dict_shape(self):
        e = ValidationError("test error", phase="validate")
        d = e.to_dict(request_id="req-123")
        self.assertEqual(d["code"], "VALIDATION_ERROR")
        self.assertEqual(d["message"], "test error")
        self.assertFalse(d["retryable"])
        self.assertEqual(d["phase"], "validate")
        self.assertEqual(d["requestId"], "req-123")

    def test_to_dict_without_request_id(self):
        e = ServiceBusyError("busy")
        d = e.to_dict()
        self.assertNotIn("requestId", d)

    def test_phase_override(self):
        e = ImageGenError("custom", phase="custom_phase")
        self.assertEqual(e.phase, "custom_phase")

    def test_retryable_override(self):
        e = ValidationError("normally not retryable", retryable=True)
        self.assertTrue(e.retryable)


if __name__ == "__main__":
    unittest.main()
