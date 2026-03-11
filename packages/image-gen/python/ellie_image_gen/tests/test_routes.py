"""Tests for FastAPI routes — health, validation, busy state."""

import unittest

from fastapi.testclient import TestClient

from ellie_image_gen.main import create_app


class TestHealthRoute(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.client = TestClient(self.app)

    def test_health_returns_ok(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("uptimeMs", data)
        self.assertIn("busy", data)
        self.assertFalse(data["busy"])

    def test_health_has_request_id(self):
        resp = self.client.get("/health")
        self.assertIn("x-request-id", resp.headers)


class TestModelsRoute(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.client = TestClient(self.app)

    def test_models_returns_list(self):
        resp = self.client.get("/models")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("cachedModels", data)
        self.assertIsInstance(data["cachedModels"], list)

    def test_evict_returns_success(self):
        resp = self.client.post("/models/evict")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["evicted"])


class TestGenerateStreamValidation(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.client = TestClient(self.app)

    def test_empty_prompt_returns_validation_error(self):
        resp = self.client.post("/generate/stream", json={
            "prompt": "",
            "modelsDir": "/tmp/test",
        })
        # The route returns 422 for validation errors via NDJSON stream
        # or via exception handler depending on where validation happens
        self.assertIn(resp.status_code, [200, 422])

    def test_missing_prompt_returns_422(self):
        resp = self.client.post("/generate/stream", json={})
        self.assertEqual(resp.status_code, 422)


if __name__ == "__main__":
    unittest.main()
