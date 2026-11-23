"""Optional provider adapter for the unified campus assistant."""

import json
import os
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


class AIProviderError(RuntimeError):
    pass


def get_provider_config() -> dict[str, str]:
    provider = (
        os.getenv("AI_PROVIDER")
        or ("openai" if os.getenv("OPENAI_API_KEY") else "")
        or ("gemini" if os.getenv("GEMINI_API_KEY") else "")
        or "none"
    ).strip().lower()

    if provider in ("openai", "openai_compatible"):
        return {
            "provider": "openai",
            "api_key": os.getenv("AI_API_KEY") or os.getenv("OPENAI_API_KEY", ""),
            "model": os.getenv("AI_MODEL") or os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            "base_url": (
                os.getenv("AI_API_BASE")
                or os.getenv("OPENAI_BASE_URL")
                or "https://api.openai.com/v1"
            ).rstrip("/"),
        }
    if provider == "gemini":
        return {
            "provider": "gemini",
            "api_key": os.getenv("AI_API_KEY") or os.getenv("GEMINI_API_KEY", ""),
            "model": os.getenv("AI_MODEL") or os.getenv("GEMINI_MODEL", "gemini-1.5-flash"),
            "base_url": (
                os.getenv("AI_API_BASE")
                or "https://generativelanguage.googleapis.com/v1beta"
            ).rstrip("/"),
        }
    return {"provider": "none", "api_key": "", "model": "", "base_url": ""}


def generate_natural_reply(
    *,
    intent: str,
    fallback_reply: str,
    user_message: str,
    verified_context: dict[str, Any],
) -> tuple[str, str]:
    config = get_provider_config()
    if config["provider"] == "none" or not config["api_key"]:
        return fallback_reply, "grounded_rule_engine"

    system = (
        "You are a Smart Campus assistant. Use only the verified_context for factual "
        "campus claims. Never grant authorization or claim that a record exists when "
        "it is absent. Placement, programming and general educational answers must be "
        "clearly separated from official campus records. Do not invent company recruiting "
        "information, marks, attendance, timetable entries or academic outcomes."
    )
    prompt = json.dumps(
        {
            "intent": intent,
            "question": user_message,
            "verified_context": verified_context,
            "fallback_reply": fallback_reply,
        },
        ensure_ascii=False,
    )

    try:
        if config["provider"] == "openai":
            body = {
                "model": config["model"],
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.2,
                "max_tokens": 600,
            }
            request = Request(
                f"{config['base_url']}/chat/completions",
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {config['api_key']}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urlopen(request, timeout=10) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise AIProviderError("Invalid provider response")
            choices = result.get("choices")
            if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                raise AIProviderError("Invalid provider response")
            message = choices[0].get("message")
            if not isinstance(message, dict) or not isinstance(message.get("content"), str):
                raise AIProviderError("Invalid provider response")
            reply = message["content"].strip()[:6000]
            return reply or fallback_reply, "openai_compatible"

        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 600},
        }
        url = f"{config['base_url']}/models/{config['model']}:generateContent"
        request = Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": config["api_key"],
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise AIProviderError("Invalid provider response")
        candidates = result.get("candidates") or []
        if not isinstance(candidates, list):
            raise AIProviderError("Invalid provider response")
        if not candidates:
            raise AIProviderError("Provider returned no candidates")
        if not isinstance(candidates[0], dict):
            raise AIProviderError("Invalid provider candidate")
        content = candidates[0].get("content")
        if not isinstance(content, dict):
            raise AIProviderError("Provider returned missing content")
        parts = content.get("parts")
        if not isinstance(parts, list):
            raise AIProviderError("Invalid provider response")
        reply = "".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ).strip()[:6000]
        return reply or fallback_reply, "gemini"
    except AIProviderError:
        raise
    except (HTTPError, URLError, KeyError, IndexError, TypeError, json.JSONDecodeError, TimeoutError) as error:
        raise AIProviderError("The configured AI provider is unavailable.") from error
    except Exception as error:
        raise AIProviderError("The configured AI provider returned an invalid response.") from error
