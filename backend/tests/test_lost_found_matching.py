import base64
import io

from PIL import Image

from services import lost_found_matching
from services.lost_found_matching import (
    _dominant_colour,
    _fallback_embedding,
    analyze_lost_found_image,
)


def test_dominant_colour_and_fallback_embedding():
    image = Image.new("RGB", (32, 32), (20, 20, 230))
    assert _dominant_colour(image) == "Blue"

    embedding = _fallback_embedding(image)
    assert len(embedding) == 16 * 16 * 3 + 48
    assert all(isinstance(value, float) for value in embedding)


def test_invalid_image_returns_failed_analysis_without_invented_label():
    result = analyze_lost_found_image("not-valid-base64")
    corrupt_result = analyze_lost_found_image(base64.b64encode(b"not an image").decode("ascii"))
    assert result["analysis_status"] == "failed"
    assert result["predicted_item"] == "Uncertain"
    assert result["embedding"] is None
    assert corrupt_result["analysis_status"] == "failed"
    assert corrupt_result["embedding"] is None


def test_declared_image_mime_must_match_actual_content():
    image = Image.new("RGB", (16, 16), (20, 20, 230))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

    mismatch = analyze_lost_found_image(encoded, "image/jpeg")

    assert mismatch["analysis_status"] == "failed"
    assert mismatch["embedding"] is None


def test_missing_pretrained_model_uses_explicit_deterministic_fallback(monkeypatch):
    image = Image.new("RGB", (16, 16), (20, 20, 230))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image_base64 = base64.b64encode(buffer.getvalue()).decode("ascii")
    monkeypatch.setattr(lost_found_matching, "_load_model", lambda: (None, None, None))

    result = analyze_lost_found_image(image_base64)

    assert result["model"] == "deterministic-fallback"
    assert result["analysis_status"] == "uncertain"
    assert result["confidence"] is None
    assert len(result["embedding"]) == 16 * 16 * 3 + 48
    assert any("weights were unavailable" in message for message in result["limitations"])
