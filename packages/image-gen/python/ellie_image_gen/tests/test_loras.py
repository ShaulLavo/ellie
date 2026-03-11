"""Tests for LoRA architecture compatibility detection."""

import unittest

from ellie_image_gen.core.loras import check_lora_arch_compatibility


class TestLoRAArchCompatibility(unittest.TestCase):
    """Test LoRA architecture compatibility detection."""

    def test_sd15_lora_on_sd15_pipeline(self):
        result = check_lora_arch_compatibility("test", "my_lora_sd15.safetensors", "sd15")
        self.assertIsNone(result)  # Compatible

    def test_sdxl_lora_on_sd15_pipeline(self):
        result = check_lora_arch_compatibility("test", "my_lora_sdxl.safetensors", "sd15")
        self.assertIsNotNone(result)  # Mismatch warning
        self.assertIn("sdxl", result)
        self.assertIn("sd15", result)

    def test_sd15_lora_on_sdxl_pipeline(self):
        result = check_lora_arch_compatibility("test", "lora_sd1.5_detail.safetensors", "sdxl")
        self.assertIsNotNone(result)  # Mismatch warning

    def test_no_arch_hint_returns_none(self):
        result = check_lora_arch_compatibility("test", "generic_lora.safetensors", "sd15")
        self.assertIsNone(result)  # Unknown arch — assume compatible


if __name__ == "__main__":
    unittest.main()
