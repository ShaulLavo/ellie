"""Scheduler/sampler registry mapping canonical names to Diffusers classes."""

from __future__ import annotations

from typing import Any

SCHEDULER_REGISTRY: dict[str, tuple[str, dict[str, Any]]] = {
    "euler":              ("EulerDiscreteScheduler", {}),
    "euler_ancestral":    ("EulerAncestralDiscreteScheduler", {}),
    "heun":               ("HeunDiscreteScheduler", {}),
    "dpm_2":              ("KDPM2DiscreteScheduler", {}),
    "dpm_2_ancestral":    ("KDPM2AncestralDiscreteScheduler", {}),
    "dpmpp_2m":           ("DPMSolverMultistepScheduler", {}),
    "dpmpp_2m_sde":       ("DPMSolverMultistepScheduler", {"algorithm_type": "sde-dpmsolver++"}),
    "dpmpp_sde":          ("DPMSolverSDEScheduler", {}),
    "ddim":               ("DDIMScheduler", {}),
    "uni_pc":             ("UniPCMultistepScheduler", {}),
    "lms":                ("LMSDiscreteScheduler", {}),
    "dpmpp_2s_ancestral": ("DPMSolverSinglestepScheduler", {}),
}


def get_scheduler_class(name: str) -> Any:
    """Import and return the scheduler class by name."""
    import diffusers
    return getattr(diffusers, name)


def apply_scheduler(pipe: Any, sampler: str, scheduler: str) -> None:
    """Configure the scheduler/sampler on a pipeline. Raises on unknown sampler."""
    entry = SCHEDULER_REGISTRY.get(sampler)
    if not entry:
        raise ValueError(f"Unknown sampler: {sampler}. Valid: {', '.join(SCHEDULER_REGISTRY.keys())}")

    class_name, extra_kwargs = entry
    SchedulerClass = get_scheduler_class(class_name)
    kwargs = dict(extra_kwargs)
    if scheduler == "karras":
        kwargs["use_karras_sigmas"] = True
    pipe.scheduler = SchedulerClass.from_config(pipe.scheduler.config, **kwargs)
