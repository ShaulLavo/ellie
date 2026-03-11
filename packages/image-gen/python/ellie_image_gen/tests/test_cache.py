"""Tests for model cache key structure and eviction policy."""

import unittest

from ellie_image_gen.core.cache import ModelCache, MAX_CACHED_PIPELINES


class TestModelCacheKey(unittest.TestCase):
    """Test that model cache keys include device and dtype."""

    def test_cache_key_includes_device_and_dtype(self):
        class FakeProfile:
            device = "cuda"
            dtype = "torch.float16"
            vram_mb = 8192
            attention_backend = "sdpa"
        cache = ModelCache(FakeProfile())
        key = cache._cache_key({"hfModelId": "test/model", "singleFilePath": ""})
        self.assertIn("cuda", key)
        self.assertIn("float16", key)
        self.assertIn("test/model", key)

    def test_different_device_produces_different_key(self):
        class FakeProfileCuda:
            device = "cuda"
            dtype = "torch.float16"
            vram_mb = 8192
            attention_backend = "sdpa"
        class FakeProfileMps:
            device = "mps"
            dtype = "torch.float32"
            vram_mb = None
            attention_backend = "default"
        cache_cuda = ModelCache(FakeProfileCuda())
        cache_mps = ModelCache(FakeProfileMps())
        config = {"hfModelId": "test/model"}
        self.assertNotEqual(
            cache_cuda._cache_key(config),
            cache_mps._cache_key(config),
        )


class TestModelCacheEviction(unittest.TestCase):
    """Test model cache eviction policy."""

    def test_max_cached_pipelines_is_one(self):
        self.assertEqual(MAX_CACHED_PIPELINES, 1)


if __name__ == "__main__":
    unittest.main()
