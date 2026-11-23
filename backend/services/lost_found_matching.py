"""Lightweight image analysis for Lost and Found matching.

Uses pretrained torchvision MobileNetV3-Small when weights are available.
Falls back to a deterministic PIL/OpenCV feature embedding when the model
cannot be loaded; the fallback never reports a classifier prediction.
"""

import base64
import io
import os
import threading
from typing import Any

import numpy as np
from PIL import Image

_model_lock = threading.Lock()
_model = None
_classifier = None
_weights = None


def _load_model() -> tuple[Any, Any, Any] | tuple[None, None, None]:
    global _model, _classifier, _weights
    if _model is not None:
        return _model, _classifier, _weights

    with _model_lock:
        if _model is not None:
            return _model, _classifier, _weights
        try:
            import torch
            from torchvision import models

            torch.set_num_threads(min(4, os.cpu_count() or 1))
            weights = models.MobileNet_V3_Small_Weights.DEFAULT
            model = models.mobilenet_v3_small(weights=weights)
            model.eval()

            # The classifier is retained for object/category labels.
            # Features are taken from the convolutional backbone.
            _model = model
            _classifier = model
            _weights = weights
            return _model, _classifier, _weights
        except Exception:
            return None, None, None


def _decode_image(image_base64: str, expected_mime_type: str | None = None) -> Image.Image:
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise ValueError("image_base64 is required")
    encoded = image_base64.strip()
    if "," in encoded and encoded.startswith("data:"):
        encoded = encoded.split(",", 1)[1]
    if len(encoded) > 7 * 1024 * 1024:
        raise ValueError("image exceeds the 5 MB limit")
    buffer = base64.b64decode(encoded, validate=True)
    if len(buffer) > 5 * 1024 * 1024:
        raise ValueError("image exceeds the 5 MB limit")
    image = Image.open(io.BytesIO(buffer))
    image.load()
    expected_format = {
        "image/jpeg": "JPEG",
        "image/png": "PNG",
        "image/webp": "WEBP",
    }.get(expected_mime_type)
    if expected_format and image.format != expected_format:
        raise ValueError("image content does not match its declared format")
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    return image


def _dominant_colour(image: Image.Image) -> str:
    rgb = image.convert("RGB").resize((64, 64))
    pixels = np.asarray(rgb, dtype=np.float32).reshape(-1, 3)
    if not len(pixels):
        return "Unknown"
    sample = pixels[::4]
    mean = sample.mean(axis=0)
    r, g, b = mean
    maximum = float(max(r, g, b))
    minimum = float(min(r, g, b))
    if maximum < 55:
        return "Black"
    if minimum > 210:
        return "White"
    if maximum - minimum < 20:
        return "Grey"
    if r > g * 1.18 and r > b * 1.18:
        return "Red"
    if g > r * 1.12 and g > b * 1.12:
        return "Green"
    if b > r * 1.12 and b > g * 1.12:
        return "Blue"
    if r > 130 and g > 110 and b < r * 0.75:
        return "Brown"
    if r > 155 and g > 120 and b < 120:
        return "Yellow"
    if r > 110 and b > 110 and g < r * 0.85:
        return "Purple"
    return "Other"


def _category_for_label(label: str) -> str:
    text = label.casefold()
    category_rules = (
        ("Bag", ("backpack", "handbag", "purse", "suitcase", "bag")),
        ("Book", ("book", "bookcase", "comic", "notebook")),
        ("Clothing", ("shirt", "coat", "jacket", "sweater", "shoe", "sock", "dress")),
        ("Electronic device", (
            "laptop", "computer", "keyboard", "mouse", "phone", "cellular",
            "calculator", "camera", "earbud", "headphone", "monitor",
        )),
        ("ID card", ("card", "badge", "wallet")),
        ("Keys", ("key", "keyring")),
        ("Bottle", ("bottle", "canteen", "mug", "cup", "thermos")),
    )
    for category, keywords in category_rules:
        if any(keyword in text for keyword in keywords):
            return category
    return "Other"


def _fallback_embedding(image: Image.Image) -> list[float]:
    small = image.convert("RGB").resize((16, 16))
    pixels = np.asarray(small, dtype=np.float32).reshape(-1, 3)
    pixels /= 255.0
    hist = []
    for channel in range(3):
        channel_hist, _ = np.histogram(
            pixels[:, channel],
            bins=16,
            range=(0.0, 1.0),
            density=True,
        )
        hist.extend(channel_hist.tolist())
    embedding = np.concatenate([pixels.reshape(-1), np.asarray(hist, dtype=np.float32)])
    norm = float(np.linalg.norm(embedding))
    if norm == 0:
        return embedding.tolist()
    return (embedding / norm).tolist()


def analyze_lost_found_image(image_base64: str, expected_mime_type: str | None = None) -> dict[str, Any]:
    try:
        image = _decode_image(image_base64, expected_mime_type)
    except Exception as error:
        return {
            "predicted_category": "Other",
            "predicted_item": "Uncertain",
            "predicted_colour": "Unknown",
            "visual_features": [],
            "analysis_status": "failed",
            "model": "none",
            "confidence": None,
            "embedding": None,
            "limitations": [str(error)],
        }

    dominant_colour = _dominant_colour(image)
    model, classifier, weights = _load_model()
    if model is None:
        return {
            "predicted_category": "Other",
            "predicted_item": "Uncertain",
            "predicted_colour": dominant_colour,
            "visual_features": [],
            "analysis_status": "uncertain",
            "model": "deterministic-fallback",
            "confidence": None,
            "embedding": _fallback_embedding(image),
            "limitations": [
                "Pretrained model weights were unavailable; no object label was invented.",
            ],
        }

    try:
        import torch
        from torchvision import transforms

        preprocess = weights.transforms()
        tensor = preprocess(image.convert("RGB")).unsqueeze(0)
        with torch.inference_mode():
            logits = classifier(tensor)
            probabilities = torch.softmax(logits, dim=1)[0]
            top_values, top_indices = torch.topk(probabilities, k=min(5, probabilities.numel()))

            features = model.features(tensor)
            features = model.avgpool(features)
            embedding = torch.flatten(features, 1)
            embedding = torch.nn.functional.normalize(embedding, p=2, dim=1)

        categories = weights.meta["categories"]
        top = [
            (categories[int(index)], float(value))
            for index, value in zip(top_indices.tolist(), top_values.tolist())
        ]
        if not top:
            raise RuntimeError("Model returned no classifications")

        confidence = top[0][1]
        label = top[0][0]
        uncertain = confidence < 0.35
        return {
            "predicted_category": _category_for_label(label) if not uncertain else "Other",
            "predicted_item": label if not uncertain else "Uncertain",
            "predicted_colour": dominant_colour,
            "visual_features": [
                candidate_label
                for candidate_label, candidate_confidence in top
                if candidate_confidence >= 0.08
            ],
            "analysis_status": "uncertain" if uncertain else "analysed",
            "model": "torchvision-MobileNet_V3_Small-ImageNet1K",
            "confidence": round(confidence, 4),
            "embedding": embedding[0].cpu().numpy().astype(float).tolist(),
            "limitations": [
                "Similarity does not prove that two reports describe the same physical item.",
                "Predictions are experimental ImageNet classifications, not ownership evidence.",
            ] if not uncertain else [
                "The model confidence was below the configured uncertainty threshold.",
                "Similarity does not prove that two reports describe the same physical item.",
            ],
        }
    except Exception as error:
        return {
            "predicted_category": "Other",
            "predicted_item": "Uncertain",
            "predicted_colour": dominant_colour,
            "visual_features": [],
            "analysis_status": "failed",
            "model": "torchvision-MobileNet_V3_Small-ImageNet1K",
            "confidence": None,
            "embedding": _fallback_embedding(image),
            "limitations": [
                f"Image analysis failed: {type(error).__name__}.",
                "No object label was invented.",
            ],
        }
