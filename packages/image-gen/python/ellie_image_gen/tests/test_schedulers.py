"""Tests for scheduler registry and apply_scheduler validation."""

import unittest

from ellie_image_gen.core.schedulers import SCHEDULER_REGISTRY, apply_scheduler


class TestSchedulerRegistry(unittest.TestCase):
    """Test that all sampler names map to valid Diffusers scheduler classes."""

    EXPECTED_SAMPLERS = [
        "euler",
        "euler_ancestral",
        "heun",
        "dpm_2",
        "dpm_2_ancestral",
        "dpmpp_2m",
        "dpmpp_2m_sde",
        "dpmpp_sde",
        "ddim",
        "uni_pc",
        "lms",
        "dpmpp_2s_ancestral",
    ]

    def test_all_samplers_mapped(self):
        for name in self.EXPECTED_SAMPLERS:
            self.assertIn(name, SCHEDULER_REGISTRY, f"Missing sampler mapping: {name}")

    def test_registry_values_are_tuples(self):
        for name, (class_name, kwargs) in SCHEDULER_REGISTRY.items():
            self.assertIsInstance(class_name, str, f"{name}: class_name should be str")
            self.assertIsInstance(kwargs, dict, f"{name}: kwargs should be dict")

    def test_dpmpp_2m_sde_has_algorithm_type(self):
        class_name, kwargs = SCHEDULER_REGISTRY["dpmpp_2m_sde"]
        self.assertEqual(class_name, "DPMSolverMultistepScheduler")
        self.assertEqual(kwargs.get("algorithm_type"), "sde-dpmsolver++")


class TestApplySchedulerValidation(unittest.TestCase):
    """Test that apply_scheduler raises on unknown sampler names."""

    def test_unknown_sampler_raises(self):
        class FakePipe:
            class scheduler:
                config = {}
        with self.assertRaises(ValueError) as ctx:
            apply_scheduler(FakePipe(), "totally_invalid", "normal")
        self.assertIn("Unknown sampler", str(ctx.exception))
        self.assertIn("totally_invalid", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
