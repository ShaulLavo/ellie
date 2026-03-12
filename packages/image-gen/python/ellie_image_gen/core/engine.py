"""Generation engine — orchestrates a single image generation request."""

from __future__ import annotations

import gc
import os
import random
import tempfile
from typing import Any

from .cache import ModelCache
from .device import DeviceProfile
from .ella import encode_prompt_with_ella, load_ella
from .loras import LoRACache, apply_loras
from .schedulers import apply_scheduler
from .textual_inversions import load_textual_inversions
from .assets import download_file
from .errors import EllaInvalidError


def handle_generate(config: dict[str, Any], profile: DeviceProfile,
                    model_cache: ModelCache, lora_cache: LoRACache,
                    emit_progress: Any = None, emit_error: Any = None) -> dict[str, Any]:
    """Handle a single generate request. Returns result dict with imagePath, width, height, seed."""
    import torch

    _progress = emit_progress or (lambda *a, **kw: None)
    _error = emit_error or (lambda *a, **kw: None)

    models_dir = config.get("modelsDir", "")
    civitai_token = config.get("civitaiToken")
    pipeline_arch = config.get("arch", "sd15")

    # Download model checkpoint if needed
    single_file_url = config.get("singleFileUrl")
    single_file_path = config.get("singleFilePath")
    if single_file_url and not single_file_path:
        filename = config.get("singleFileFilename", "model.safetensors")
        dest = os.path.join(models_dir, "checkpoints", filename)
        single_file_path = download_file(single_file_url, dest, civitai_token,
                                         label=filename,
                                         emit_progress=emit_progress)
        config["singleFilePath"] = single_file_path

    # Load pipeline (cached, with eviction)
    pipe = model_cache.get_or_load(config, emit_progress=emit_progress)

    # Set scheduler (raises on unknown sampler)
    apply_scheduler(pipe, config.get("sampler", "euler"), config.get("scheduler", "normal"))

    # Download + apply LoRAs with arch compatibility checks
    loras = config.get("loras", [])
    for lora in loras:
        if not lora.get("path"):
            lora["path"] = lora_cache.ensure_downloaded(lora, civitai_token,
                                                         emit_progress=emit_progress)
    applied_loras = apply_loras(pipe, loras, lora_cache, pipeline_arch, civitai_token,
                                emit_progress=emit_progress, emit_error=emit_error)
    cache_key = model_cache._cache_key(config)
    model_cache._lora_state[cache_key] = applied_loras

    # Load textual inversions
    load_textual_inversions(pipe, config.get("textualInversions", []), civitai_token,
                            emit_progress=emit_progress)

    # ELLA (SD 1.5 only — validated at API boundary, but double-check here)
    use_ella = config.get("useElla", False)
    ella_components = None
    if use_ella:
        if pipeline_arch != "sd15":
            _error("ELLA is only supported on SD 1.5 pipelines", phase="ella")
            use_ella = False
        else:
            ella_components = load_ella(pipe, config, profile.device, profile.dtype,
                                        emit_progress=emit_progress)

    # Prepare generation
    seed = config.get("seed", -1)
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    generator = torch.Generator(device="cpu").manual_seed(seed)
    total_steps = config.get("steps", 25)

    def step_callback(pipe_obj: Any, step: int, timestep: Any, callback_kwargs: dict) -> dict:
        _progress("denoise", step=step + 1, totalSteps=total_steps)
        return callback_kwargs

    gen_kwargs: dict[str, Any] = {
        "prompt": config["prompt"],
        "negative_prompt": config.get("negativePrompt"),
        "width": config.get("width", 512),
        "height": config.get("height", 512),
        "num_inference_steps": total_steps,
        "guidance_scale": config.get("cfgScale", 7.0),
        "generator": generator,
        "num_images_per_prompt": config.get("batchSize", 1),
        "callback_on_step_end": step_callback,
    }

    # ELLA conditioning: project through adapter, not raw T5 injection
    if use_ella and ella_components:
        projected_embeds = encode_prompt_with_ella(
            ella_components, config["prompt"], profile.device, profile.dtype
        )
        gen_kwargs["prompt_embeds"] = projected_embeds
        del gen_kwargs["prompt"]

    _progress("denoise", step=0, totalSteps=total_steps)
    result = pipe(**gen_kwargs)

    # Save output
    images = result.images
    _progress("save", f"Encoding {len(images)} image(s)")

    saved_images: list[dict[str, Any]] = []
    for i, image in enumerate(images):
        out = config.get("outputPath") if i == 0 else None
        if not out:
            fd, out = tempfile.mkstemp(suffix=".png", prefix=f"gen-{i}-")
            os.close(fd)
        image.save(out, format="PNG")
        saved_images.append({
            "imagePath": out,
            "width": image.width,
            "height": image.height,
        })

    _progress("save", "Done")

    result_data = {
        # Primary image (backwards compat)
        "imagePath": saved_images[0]["imagePath"],
        "width": saved_images[0]["width"],
        "height": saved_images[0]["height"],
        "seed": seed,
        # Full batch
        "images": saved_images,
    }

    # Cleanup ELLA (heavy — free T5 encoder after each gen)
    if ella_components:
        del ella_components
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

    return result_data
