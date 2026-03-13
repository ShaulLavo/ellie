"""Face/hand detail enhancement via YOLO detection + inpainting.

Implements the ADetailer pattern: detect regions of interest (faces, hands),
generate masks (segmentation when available, bbox fallback), preprocess masks
(dilate/erode, offset, merge/invert, filter by ratio/top-k, sort), crop to
mask for focused inpainting, then re-inpaint those regions at higher detail.

Logic mirrors https://github.com/Bing-su/adetailer faithfully.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from enum import IntEnum
from functools import reduce
from math import dist
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter


# ── Data types ───────────────────────────────────────────────────────────────

@dataclass
class PredictOutput:
    bboxes: list[list[float]] = field(default_factory=list)
    masks: list[Image.Image] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    preview: Image.Image | None = None


class SortBy(IntEnum):
    NONE = 0
    LEFT_TO_RIGHT = 1
    CENTER_TO_EDGE = 2
    AREA = 3


class MergeInvert(IntEnum):
    NONE = 0
    MERGE = 1
    MERGE_INVERT = 2


# ── Detection model registry ────────────────────────────────────────────────

DETECTION_MODELS: dict[str, dict[str, str]] = {
    "face_yolov8n": {
        "repo_id": "Bingsu/adetailer",
        "filename": "face_yolov8n.pt",
    },
    "hand_yolov8n": {
        "repo_id": "Bingsu/adetailer",
        "filename": "hand_yolov8n.pt",
    },
}


# ── Model download ──────────────────────────────────────────────────────────

def _ensure_model(model_key: str, models_dir: str, emit_progress: Any = None) -> str:
    """Download YOLO model if not cached. Returns local path."""
    from huggingface_hub import hf_hub_download

    info = DETECTION_MODELS[model_key]
    cache_dir = os.path.join(models_dir, "adetailer")
    local_path = os.path.join(cache_dir, info["filename"])

    if os.path.isfile(local_path):
        return local_path

    _progress = emit_progress or (lambda *a, **kw: None)
    _progress("adetailer", f"Downloading {info['filename']}...")

    path = hf_hub_download(
        repo_id=info["repo_id"],
        filename=info["filename"],
        local_dir=cache_dir,
    )
    return path


# ── Detection ────────────────────────────────────────────────────────────────

def _create_mask_from_bbox(
    bboxes: list[list[float]], shape: tuple[int, int]
) -> list[Image.Image]:
    """Create rectangular L-mode masks from bounding boxes (matches reference
    ``create_mask_from_bbox`` in ``common.py``)."""
    masks = []
    for bbox in bboxes:
        mask = Image.new("L", shape, 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rectangle(bbox, fill=255)
        masks.append(mask)
    return masks


def _create_bbox_from_mask(
    masks: list[Image.Image], shape: tuple[int, int]
) -> list[list[int]]:
    """Derive tight bounding boxes from masks (matches reference
    ``create_bbox_from_mask`` in ``common.py``).

    Used after mask preprocessing (dilate/erode may have changed the mask
    shape) to get the actual region for inpaint-only-masked cropping.
    """
    bboxes: list[list[int]] = []
    for mask in masks:
        mask = mask.resize(shape)
        bbox = mask.getbbox()
        if bbox is not None:
            bboxes.append(list(bbox))
    return bboxes


def _ensure_pil_image(image: Any, mode: str = "RGB") -> Image.Image:
    """Convert to PIL Image in the requested mode (matches reference
    ``ensure_pil_image`` in ``common.py``)."""
    if not isinstance(image, Image.Image):
        from torchvision.transforms.functional import to_pil_image
        image = to_pil_image(image)
    if image.mode != mode:
        image = image.convert(mode)
    return image


def _mask_to_pil(masks_tensor: Any, shape: tuple[int, int]) -> list[Image.Image]:
    """Convert YOLO segmentation tensor (N,H,W) to list of PIL L-mode masks
    (matches reference ``mask_to_pil`` in ``ultralytics.py``)."""
    from torchvision.transforms.functional import to_pil_image

    masks_tensor = masks_tensor.float()
    n = masks_tensor.shape[0]
    return [to_pil_image(masks_tensor[i], mode="L").resize(shape) for i in range(n)]


def _apply_classes(model: Any, model_path: str | Path, classes: str) -> None:
    """Set custom classes for YOLOWorld models (matches reference
    ``apply_classes`` in ``ultralytics.py``)."""
    if not classes or "-world" not in Path(model_path).stem:
        return
    parsed = [c.strip() for c in classes.split(",") if c.strip()]
    if parsed:
        model.set_classes(parsed)


def _detect_regions(
    image: Image.Image,
    model_path: str,
    confidence: float = 0.3,
    device: str = "",
    classes: str = "",
) -> PredictOutput:
    """Run YOLO inference. Returns PredictOutput with bboxes, masks,
    confidences, preview (matches reference ``ultralytics_predict``)."""
    from ultralytics import YOLO

    model = YOLO(model_path)
    _apply_classes(model, model_path, classes)
    pred = model(image, conf=confidence, device=device)

    bboxes = pred[0].boxes.xyxy.cpu().numpy()
    if bboxes.size == 0:
        return PredictOutput()
    bboxes = bboxes.tolist()

    # Use segmentation masks when available, fall back to bbox masks
    if pred[0].masks is None:
        masks = _create_mask_from_bbox(bboxes, image.size)
    else:
        masks = _mask_to_pil(pred[0].masks.data, image.size)

    confidences = pred[0].boxes.conf.cpu().numpy().tolist()

    # Generate preview image
    preview = pred[0].plot()
    preview = cv2.cvtColor(preview, cv2.COLOR_BGR2RGB)
    preview = Image.fromarray(preview)

    return PredictOutput(
        bboxes=bboxes, masks=masks, confidences=confidences, preview=preview
    )


# ── Mask morphological operations ────────────────────────────────────────────

def _dilate(arr: np.ndarray, value: int) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (value, value))
    return cv2.dilate(arr, kernel, iterations=1)


def _erode(arr: np.ndarray, value: int) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (value, value))
    return cv2.erode(arr, kernel, iterations=1)


def _dilate_erode(img: Image.Image, value: int) -> Image.Image:
    """Positive value dilates, negative erodes (matches reference
    ``dilate_erode`` in ``mask.py``)."""
    if value == 0:
        return img
    arr = np.array(img)
    arr = _dilate(arr, value) if value > 0 else _erode(arr, -value)
    return Image.fromarray(arr)


def _offset(img: Image.Image, x: int = 0, y: int = 0) -> Image.Image:
    """Offset mask by x (right) and y (up) (matches reference ``offset`` in
    ``mask.py``)."""
    return ImageChops.offset(img, x, -y)


def _is_all_black(img: Image.Image | np.ndarray) -> bool:
    if isinstance(img, Image.Image):
        img = np.array(_ensure_pil_image(img, "L"))
    return cv2.countNonZero(img) == 0


def _has_intersection(im1: Any, im2: Any) -> bool:
    arr1 = np.array(_ensure_pil_image(im1, "L"))
    arr2 = np.array(_ensure_pil_image(im2, "L"))
    return not _is_all_black(cv2.bitwise_and(arr1, arr2))


# ── Mask merge / invert ─────────────────────────────────────────────────────

def _mask_merge(masks: list[Image.Image]) -> list[Image.Image]:
    arrs = [np.array(m) for m in masks]
    arr = reduce(cv2.bitwise_or, arrs)
    return [Image.fromarray(arr)]


def _mask_invert(masks: list[Image.Image]) -> list[Image.Image]:
    return [ImageChops.invert(m) for m in masks]


def _mask_merge_invert(
    masks: list[Image.Image], mode: int | MergeInvert
) -> list[Image.Image]:
    if mode == MergeInvert.NONE or not masks:
        return masks
    if mode == MergeInvert.MERGE:
        return _mask_merge(masks)
    if mode == MergeInvert.MERGE_INVERT:
        merged = _mask_merge(masks)
        return _mask_invert(merged)
    return masks


# ── Bbox utilities ───────────────────────────────────────────────────────────

def _bbox_area(bbox: list) -> float:
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


# ── Filtering ────────────────────────────────────────────────────────────────

def _filter_by_ratio(
    pred: PredictOutput, low: float, high: float
) -> PredictOutput:
    """Filter detections by bbox area ratio relative to image area (matches
    reference ``filter_by_ratio`` in ``mask.py``)."""
    if not pred.bboxes:
        return pred
    w, h = pred.preview.size
    orig_area = w * h
    idx = [
        i for i in range(len(pred.bboxes))
        if low <= _bbox_area(pred.bboxes[i]) / orig_area <= high
    ]
    pred.bboxes = [pred.bboxes[i] for i in idx]
    pred.masks = [pred.masks[i] for i in idx]
    pred.confidences = [pred.confidences[i] for i in idx]
    return pred


def _filter_k_largest(pred: PredictOutput, k: int = 0) -> PredictOutput:
    if not pred.bboxes or k == 0:
        return pred
    areas = [_bbox_area(bbox) for bbox in pred.bboxes]
    idx = np.argsort(areas)[-k:]
    idx = idx[::-1]
    pred.bboxes = [pred.bboxes[i] for i in idx]
    pred.masks = [pred.masks[i] for i in idx]
    pred.confidences = [pred.confidences[i] for i in idx]
    return pred


def _filter_k_most_confident(pred: PredictOutput, k: int = 0) -> PredictOutput:
    if not pred.bboxes or not pred.confidences or k == 0:
        return pred
    idx = np.argsort(pred.confidences)[-k:]
    idx = idx[::-1]
    pred.bboxes = [pred.bboxes[i] for i in idx]
    pred.masks = [pred.masks[i] for i in idx]
    pred.confidences = [pred.confidences[i] for i in idx]
    return pred


def _filter_k_by(
    pred: PredictOutput, k: int = 0, by: str = "Area"
) -> PredictOutput:
    if by == "Area":
        return _filter_k_largest(pred, k)
    if by == "Confidence":
        return _filter_k_most_confident(pred, k)
    return pred


# ── Sorting ──────────────────────────────────────────────────────────────────

def _sort_bboxes(
    pred: PredictOutput, order: int | SortBy = SortBy.NONE
) -> PredictOutput:
    """Sort bboxes and their masks by the given order (matches reference
    ``sort_bboxes`` in ``mask.py``)."""
    if order == SortBy.NONE or len(pred.bboxes) <= 1:
        return pred

    if order == SortBy.LEFT_TO_RIGHT:
        key_fn = lambda bbox: bbox[0]
    elif order == SortBy.CENTER_TO_EDGE:
        width, height = pred.preview.size
        center = (width / 2, height / 2)
        key_fn = lambda bbox: dist(center, ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2))
    elif order == SortBy.AREA:
        key_fn = lambda bbox: -_bbox_area(bbox)
    else:
        return pred

    items = len(pred.bboxes)
    idx = sorted(range(items), key=lambda i: key_fn(pred.bboxes[i]))
    pred.bboxes = [pred.bboxes[i] for i in idx]
    pred.masks = [pred.masks[i] for i in idx]
    return pred


# ── Mask preprocessing pipeline ──────────────────────────────────────────────

def _mask_preprocess(
    masks: list[Image.Image],
    kernel: int = 0,
    x_offset: int = 0,
    y_offset: int = 0,
    merge_invert: int | MergeInvert = MergeInvert.NONE,
) -> list[Image.Image]:
    """Full mask preprocessing: offset -> dilate/erode -> merge/invert
    (matches reference ``mask_preprocess`` in ``mask.py``)."""
    if not masks:
        return []

    if x_offset != 0 or y_offset != 0:
        masks = [_offset(m, x_offset, y_offset) for m in masks]

    if kernel != 0:
        masks = [_dilate_erode(m, kernel) for m in masks]
        masks = [m for m in masks if not _is_all_black(m)]

    return _mask_merge_invert(masks, mode=merge_invert)


# ── Dynamic denoise strength ────────────────────────────────────────────────

def _dynamic_denoise_strength(
    denoise_power: float,
    denoise_strength: float,
    bbox: list,
    image_size: tuple[int, int],
) -> float:
    """Scale denoise strength by bbox area ratio.  Smaller areas get more
    denoising (matches reference ``dynamic_denoise_strength`` in ``opts.py``)."""
    if len(bbox) != 4:
        return denoise_strength

    if np.isclose(denoise_power, 0.0):
        return denoise_strength

    width, height = image_size
    image_pixels = width * height
    bbox_pixels = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    normalized_area = bbox_pixels / image_pixels
    denoise_modifier = (1.0 - normalized_area) ** denoise_power

    return denoise_strength * denoise_modifier


# ── Optimal crop size ────────────────────────────────────────────────────────

SDXL_RESOLUTIONS: list[tuple[int, int]] = [
    (1024, 1024),
    (1152, 896),
    (896, 1152),
    (1216, 832),
    (832, 1216),
    (1344, 768),
    (768, 1344),
    (1536, 640),
    (640, 1536),
]


def _optimal_crop_size_sdxl(
    inpaint_width: int, inpaint_height: int, bbox: list
) -> tuple[int, int]:
    """Find best SDXL resolution matching bbox aspect ratio (matches reference
    ``_OptimalCropSize.sdxl`` in ``opts.py``)."""
    if len(bbox) != 4:
        return inpaint_width, inpaint_height

    bbox_width = bbox[2] - bbox[0]
    bbox_height = bbox[3] - bbox[1]
    bbox_aspect_ratio = bbox_width / bbox_height

    resolutions = [
        res for res in SDXL_RESOLUTIONS
        if (res[0] >= bbox_width and res[1] >= bbox_height)
        and (res[0] >= inpaint_width or res[1] >= inpaint_height)
    ]

    if not resolutions:
        return inpaint_width, inpaint_height

    return min(resolutions, key=lambda res: abs((res[0] / res[1]) - bbox_aspect_ratio))


def _optimal_crop_size_free(
    inpaint_width: int, inpaint_height: int, bbox: list
) -> tuple[int, int]:
    """Find optimal dimensions matching bbox aspect ratio, rounded to 8px
    (matches reference ``_OptimalCropSize.free`` in ``opts.py``)."""
    if len(bbox) != 4:
        return inpaint_width, inpaint_height

    bbox_width = bbox[2] - bbox[0]
    bbox_height = bbox[3] - bbox[1]
    bbox_aspect_ratio = bbox_width / bbox_height

    scale_size = max(inpaint_width, inpaint_height)

    if bbox_aspect_ratio > 1:
        optimal_width = scale_size
        optimal_height = scale_size / bbox_aspect_ratio
    else:
        optimal_width = scale_size * bbox_aspect_ratio
        optimal_height = scale_size

    # Round up to nearest multiple of 8
    optimal_width = int(((optimal_width + 8 - 1) // 8) * 8)
    optimal_height = int(((optimal_height + 8 - 1) // 8) * 8)

    return optimal_width, optimal_height


def _get_optimal_crop_image_size(
    inpaint_width: int,
    inpaint_height: int,
    bbox: list,
    mode: str = "Off",
) -> tuple[int, int]:
    """Wrapper matching reference ``get_optimal_crop_image_size`` in
    ``!adetailer.py``."""
    if mode == "Off":
        return inpaint_width, inpaint_height

    if mode == "Strict":
        return _optimal_crop_size_sdxl(inpaint_width, inpaint_height, bbox)

    if mode == "Free":
        return _optimal_crop_size_free(inpaint_width, inpaint_height, bbox)

    return inpaint_width, inpaint_height


# ── Prompt handling ──────────────────────────────────────────────────────────

def _parse_prompt(
    ad_prompt: str, fallback_prompt: str
) -> list[str]:
    """Split prompt by [SEP] and replace blank / [PROMPT] tokens (matches
    reference ``_get_prompt`` in ``!adetailer.py``)."""
    prompts = re.split(r"\s*\[SEP\]\s*", ad_prompt)
    for n in range(len(prompts)):
        if not prompts[n]:
            prompts[n] = fallback_prompt
        elif "[PROMPT]" in prompts[n]:
            prompts[n] = prompts[n].replace("[PROMPT]", fallback_prompt)
    return prompts


# ── Inpaint-only-masked (crop, inpaint, composite) ──────────────────────────

def _crop_to_mask(
    image: Image.Image,
    mask: Image.Image,
    padding: int = 32,
) -> tuple[Image.Image, Image.Image, tuple[int, int, int, int]]:
    """Crop image and mask to the mask's bounding box plus padding.

    Returns (cropped_image, cropped_mask, crop_box).
    Mirrors the behaviour of A1111's ``inpaint_full_res`` mode.
    """
    w, h = image.size
    bbox = mask.getbbox()
    if bbox is None:
        return image, mask, (0, 0, w, h)

    x1, y1, x2, y2 = bbox

    # Expand by padding, clamp to image bounds
    x1 = max(0, x1 - padding)
    y1 = max(0, y1 - padding)
    x2 = min(w, x2 + padding)
    y2 = min(h, y2 + padding)

    crop_box = (x1, y1, x2, y2)
    cropped_image = image.crop(crop_box)
    cropped_mask = mask.crop(crop_box)

    return cropped_image, cropped_mask, crop_box


def _composite_back(
    original: Image.Image,
    inpainted_crop: Image.Image,
    full_mask: Image.Image,
    crop_box: tuple[int, int, int, int],
) -> Image.Image:
    """Paste inpainted crop back into the original image using the full-size
    mask for blending.  Mirrors the composite step of A1111's
    ``inpaint_full_res``.

    ``full_mask`` must be the full-size (not cropped) blurred mask so that
    ``full_mask.crop(crop_box)`` produces the correct alpha region.
    """
    x1, y1, x2, y2 = crop_box
    crop_w = x2 - x1
    crop_h = y2 - y1

    # Resize inpainted result back to crop dimensions
    inpainted_resized = inpainted_crop.resize((crop_w, crop_h), Image.LANCZOS)

    # Crop the FULL-SIZE mask to get the blending alpha for this region
    crop_mask = full_mask.crop(crop_box)

    result = original.copy()
    result.paste(inpainted_resized, (x1, y1), crop_mask)

    return result


# ── Inpainting ───────────────────────────────────────────────────────────────

def _inpaint_region(
    pipe: Any,
    image: Image.Image,
    mask: Image.Image,
    prompt: str,
    negative_prompt: str | None,
    cfg_scale: float,
    steps: int,
    strength: float,
    seed: int,
    clip_skip: int,
    mask_blur: int,
    width: int,
    height: int,
    inpaint_only_masked: bool,
    inpaint_only_masked_padding: int,
    device: str,
    dtype: Any,
) -> Image.Image:
    """Inpaint a masked region using AutoPipelineForInpainting.

    When ``inpaint_only_masked`` is True (default), crops to the mask region
    with padding, inpaints at the target resolution, then composites back.
    This mirrors A1111's ``inpaint_full_res`` and is critical for quality.

    ``width`` and ``height`` are the target inpaint resolution.  The reference
    always has these set (via ``get_width_height`` which defaults to the
    original generation dimensions).
    """
    import torch
    from diffusers import AutoPipelineForInpainting

    # Ensure image is RGB (matches reference ensure_pil_image call before
    # each inpaint iteration in _postprocess_image_inner)
    image = _ensure_pil_image(image, "RGB")

    inpaint_pipe = AutoPipelineForInpainting.from_pipe(pipe)

    # Clear any inherited callback from the parent pipeline to prevent
    # it from firing "denoise" progress events with wrong totalSteps
    inpaint_pipe.callback_on_step_end = None

    generator = torch.Generator(device="cpu").manual_seed(seed)

    # Apply mask blur (separate from dilate/erode — matches reference
    # ``mask_blur`` param on StableDiffusionProcessingImg2Img)
    if mask_blur > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=mask_blur))

    # Inpaint-only-masked: crop to mask region, inpaint the crop at target
    # resolution, composite back.  Mirrors A1111's inpaint_full_res +
    # inpaint_full_res_padding.
    crop_box: tuple[int, int, int, int] | None = None
    original_image: Image.Image | None = None
    full_mask: Image.Image | None = None

    if inpaint_only_masked:
        original_image = image
        full_mask = mask  # save full-size blurred mask BEFORE cropping
        image, mask, crop_box = _crop_to_mask(
            image, mask, padding=inpaint_only_masked_padding
        )

    kwargs: dict[str, Any] = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "image": image,
        "mask_image": mask,
        "guidance_scale": cfg_scale,
        "num_inference_steps": steps,
        "strength": strength,
        "generator": generator,
        "width": width,
        "height": height,
    }

    # clip_skip only if > 1 (default=1 means no skip)
    if clip_skip > 1:
        kwargs["clip_skip"] = clip_skip

    result = inpaint_pipe(**kwargs)
    inpainted = result.images[0]

    # Composite back if we cropped — use the FULL-SIZE blurred mask so that
    # crop coordinates are correct and soft edges blend properly
    if inpaint_only_masked and original_image is not None and crop_box is not None:
        inpainted = _composite_back(
            original_image, inpainted, full_mask, crop_box
        )

    return inpainted


# ── Prediction preprocessing (matches reference pred_preprocessing) ──────────

def _pred_preprocessing(
    pred: PredictOutput,
    *,
    mask_min_ratio: float = 0.0,
    mask_max_ratio: float = 1.0,
    mask_k: int = 0,
    mask_filter_method: str = "Area",
    sort_by: int | SortBy = SortBy.NONE,
    dilate_erode: int = 4,
    x_offset: int = 0,
    y_offset: int = 0,
    mask_merge_invert: int | MergeInvert = MergeInvert.NONE,
) -> list[Image.Image]:
    """Full prediction preprocessing pipeline matching the reference
    ``pred_preprocessing`` in ``!adetailer.py``."""
    pred = _filter_by_ratio(pred, low=mask_min_ratio, high=mask_max_ratio)
    pred = _filter_k_by(pred, k=mask_k, by=mask_filter_method)
    pred = _sort_bboxes(pred, sort_by)
    masks = _mask_preprocess(
        pred.masks,
        kernel=dilate_erode,
        x_offset=x_offset,
        y_offset=y_offset,
        merge_invert=mask_merge_invert,
    )
    return masks


# ── Public API ───────────────────────────────────────────────────────────────

def apply_adetailer(
    images: list[Image.Image],
    pipe: Any,
    config: dict[str, Any],
    device: str,
    dtype: Any,
    emit_progress: Any = None,
    emit_error: Any = None,
) -> list[Image.Image]:
    """Apply face/hand detail enhancement to a batch of generated images.

    Detects faces and hands using YOLO, preprocesses masks (dilate/erode,
    offset, filter, sort, merge/invert), then inpaints each region at higher
    detail using crop-to-mask compositing.  Returns enhanced images (or
    originals on failure).
    """
    _progress = emit_progress or (lambda *a, **kw: None)
    _error = emit_error or (lambda *a, **kw: None)

    # ── Read config ──────────────────────────────────────────────────────
    models_dir = config.get("modelsDir", "")
    detect_faces = config.get("adetailerDetectFaces", True)
    detect_hands = config.get("adetailerDetectHands", True)

    # Inpainting params
    strength = config.get("adetailerStrength", 0.4)
    inpaint_steps = config.get("adetailerSteps", 20)
    cfg_scale = config.get("cfgScale", 7.0)
    confidence = config.get("adetailerConfidence", 0.3)
    clip_skip = config.get("clipSkip", 1)
    seed = config.get("seed", 0)
    prompt = config.get("prompt", "")
    negative_prompt = config.get("negativePrompt")

    # Mask params (matching reference defaults from ADetailerArgs)
    mask_blur = config.get("adetailerMaskBlur", 4)
    dilate_erode = config.get("adetailerDilateErode", 4)
    x_offset = config.get("adetailerXOffset", 0)
    y_offset = config.get("adetailerYOffset", 0)
    mask_merge_invert = config.get("adetailerMaskMergeInvert", MergeInvert.NONE)
    mask_min_ratio = config.get("adetailerMaskMinRatio", 0.0)
    mask_max_ratio = config.get("adetailerMaskMaxRatio", 1.0)
    mask_k = config.get("adetailerMaskTopK", 0)
    mask_filter_method = config.get("adetailerMaskFilterMethod", "Area")
    sort_by = config.get("adetailerSortBy", SortBy.NONE)

    # Inpaint only masked (crop to detection, inpaint at full res, composite)
    # Matches reference: ad_inpaint_only_masked (default True) +
    # ad_inpaint_only_masked_padding (default 32)
    inpaint_only_masked = config.get("adetailerInpaintOnlyMasked", True)
    inpaint_only_masked_padding = config.get("adetailerInpaintPadding", 32)

    # Optional separate inpaint dimensions
    # Matches reference: ad_use_inpaint_width_height, ad_inpaint_width/height
    use_inpaint_wh = config.get("adetailerUseInpaintWidthHeight", False)
    inpaint_width = config.get("adetailerInpaintWidth", None)
    inpaint_height = config.get("adetailerInpaintHeight", None)

    # Dynamic denoise strength (matches reference ad_dynamic_denoise_power)
    denoise_power = config.get("adetailerDenoisePower", 0)

    # ADetailer prompt (supports [SEP] and [PROMPT])
    ad_prompt = config.get("adetailerPrompt", "")
    ad_negative_prompt = config.get("adetailerNegativePrompt", "")

    # YOLO device (empty string = auto; matches reference get_ultralytics_device)
    yolo_device = config.get("adetailerDevice", "")

    # YOLOWorld custom classes
    yolo_classes = config.get("adetailerModelClasses", "")

    # Generation dimensions — used as default inpaint target resolution
    # when no explicit inpaint width/height is set.  Matches reference
    # get_width_height() which defaults to p.width / p.height.
    gen_width = config.get("width", 512)
    gen_height = config.get("height", 512)

    # Optimal crop size mode (matches reference ad_match_inpaint_bbox_size)
    optimal_crop_mode = config.get("adetailerOptimalCropMode", "Off")

    # ── Collect detection model paths ────────────────────────────────────
    model_paths: list[tuple[str, str]] = []  # (label, path)
    try:
        if detect_faces:
            path = _ensure_model("face_yolov8n", models_dir, emit_progress)
            model_paths.append(("face", path))
        if detect_hands:
            path = _ensure_model("hand_yolov8n", models_dir, emit_progress)
            model_paths.append(("hand", path))
    except Exception as exc:
        _error(f"Failed to load ADetailer detection models: {exc}", phase="adetailer")
        return images  # graceful fallback

    if not model_paths:
        return images

    # Parse prompt with [SEP] / [PROMPT] support
    prompts = _parse_prompt(ad_prompt, prompt) if ad_prompt else [prompt]
    neg_prompts = (
        _parse_prompt(ad_negative_prompt, negative_prompt or "")
        if ad_negative_prompt
        else [negative_prompt or ""]
    )

    enhanced: list[Image.Image] = []

    for img_idx, image in enumerate(images):
        _progress("adetailer", f"Processing image {img_idx + 1}/{len(images)}")
        current = image

        for label, model_path in model_paths:
            pred = _detect_regions(
                current,
                model_path,
                confidence=confidence,
                device=yolo_device,
                classes=yolo_classes,
            )

            if pred.preview is None:
                # Nothing detected
                continue

            _progress(
                "adetailer",
                f"Found {len(pred.bboxes)} {label}(s) in image {img_idx + 1}",
                step=img_idx + 1,
                totalSteps=len(images),
            )

            # Full mask preprocessing pipeline (matches pred_preprocessing)
            masks = _pred_preprocessing(
                pred,
                mask_min_ratio=mask_min_ratio,
                mask_max_ratio=mask_max_ratio,
                mask_k=mask_k,
                mask_filter_method=mask_filter_method,
                sort_by=sort_by,
                dilate_erode=dilate_erode,
                x_offset=x_offset,
                y_offset=y_offset,
                mask_merge_invert=mask_merge_invert,
            )

            if not masks:
                continue

            for det_idx, mask in enumerate(masks):
                if _is_all_black(mask):
                    continue

                # Per-detection prompt (via [SEP] splitting)
                # Matches reference i2i_prompts_replace: min(j, len-1)
                p_idx = min(det_idx, len(prompts) - 1)
                n_idx = min(det_idx, len(neg_prompts) - 1)
                det_prompt = prompts[p_idx]
                det_neg_prompt = neg_prompts[n_idx]

                # [SKIP] support (matches reference regex check)
                if re.match(r"^\s*\[SKIP\]\s*$", det_prompt):
                    continue

                # Dynamic denoise strength based on bbox area
                # (matches reference fix_p2 -> get_dynamic_denoise_strength)
                det_strength = strength
                if denoise_power != 0 and det_idx < len(pred.bboxes):
                    det_strength = _dynamic_denoise_strength(
                        denoise_power, strength, pred.bboxes[det_idx], current.size
                    )

                # Determine inpaint dimensions (matches reference
                # get_width_height: explicit > original generation dims)
                if use_inpaint_wh and inpaint_width and inpaint_height:
                    inp_w = inpaint_width
                    inp_h = inpaint_height
                else:
                    inp_w = gen_width
                    inp_h = gen_height

                # Optimal crop size: when not using explicit dimensions, try to
                # match inpaint size to bbox aspect ratio
                # (matches reference fix_p2 -> get_optimal_crop_image_size)
                if not use_inpaint_wh and det_idx < len(pred.bboxes):
                    inp_w, inp_h = _get_optimal_crop_image_size(
                        inp_w, inp_h, pred.bboxes[det_idx], mode=optimal_crop_mode
                    )

                try:
                    current = _inpaint_region(
                        pipe=pipe,
                        image=current,
                        mask=mask,
                        prompt=det_prompt,
                        negative_prompt=det_neg_prompt,
                        cfg_scale=cfg_scale,
                        steps=inpaint_steps,
                        strength=det_strength,
                        seed=seed + det_idx,
                        clip_skip=clip_skip,
                        mask_blur=mask_blur,
                        width=inp_w,
                        height=inp_h,
                        inpaint_only_masked=inpaint_only_masked,
                        inpaint_only_masked_padding=inpaint_only_masked_padding,
                        device=device,
                        dtype=dtype,
                    )
                except Exception as exc:
                    _error(
                        f"ADetailer inpaint failed for {label} #{det_idx + 1}: {exc}",
                        phase="adetailer",
                    )
                    # Continue with current image (skip this detection)

        enhanced.append(current)

    return enhanced
