"""Scheduler/sampler registry mapping canonical names to Diffusers classes."""

from __future__ import annotations

from typing import Any

# Scheduler-class-specific params that must NOT leak when switching classes.
# These cause silent NaN corruption or explicit errors on incompatible schedulers
# (e.g. DEIS solver_type="logrho" → NaN in DPMSolverSDE,
#  DEIS algorithm_type="deis" → error in DPMSolverMultistep).
# Everything else (timestep_spacing, steps_offset, clip_sample, etc.) is
# safe to inherit and important for quality.
_BLOCKED_SCHEDULER_KEYS = {
    "solver_type",       # DEIS-specific (logrho)
    "algorithm_type",    # DEIS/DPM-specific (deis, dpmsolver++, sde-dpmsolver++)
    "solver_order",      # multistep-solver-specific
    "lower_order_final", # multistep-solver-specific
    "euler_at_final",    # solver-specific
    "final_sigmas_type", # solver-specific
    "lambda_min_clipped",# solver-specific
    "variance_type",     # DDPM-specific
    "use_karras_sigmas", # controlled by our scheduler param, don't inherit
    "use_lu_lambdas",    # controlled by our scheduler param, don't inherit
}

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
    # Inherit the model's scheduler config but strip class-specific params
    # that cause corruption or errors on the target scheduler class.
    old_config = {k: v for k, v in dict(pipe.scheduler.config).items()
                  if k not in _BLOCKED_SCHEDULER_KEYS}
    old_config.update(kwargs)
    pipe.scheduler = SchedulerClass.from_config(old_config)
