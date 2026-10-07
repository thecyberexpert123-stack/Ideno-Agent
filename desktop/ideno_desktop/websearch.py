"""One web-search endpoint, called on the page's behalf.

This exists for a single concrete reason: a browser enforces CORS on a cross-origin
``fetch``, and whether Tavily permits calls from a web page is not something Ideno
controls. The desktop host has no such restriction, so the same search works here
when it may not work in a browser.

## This is not a proxy

The method takes a *search query and options*, not a URL. It knows exactly one
endpoint and builds the request itself, ignoring anything in the payload that looks
like a destination.

That distinction is the whole security argument. A bridge that accepted a URL would
be an open HTTP proxy for whatever ends up running in the page — able to reach the
loopback interface, cloud metadata endpoints, and anything else on the local network
that the user's machine can see. Accepting only a query means the worst a compromised
page can do through this method is spend the user's search credits.

## Dependencies

Standard library only. ``urllib.request`` is enough for one POST, and adding an HTTP
client dependency to a host whose runtime deps are already three packages would not
be a trade worth making.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger("ideno.websearch")

#: The only endpoint this module will ever contact.
TAVILY_URL = "https://api.tavily.com/search"

#: Environment fallback, so a key can live outside the browser entirely.
TAVILY_ENV_VAR = "TAVILY_API_KEY"

#: Ceiling on results, whatever the page asks for.
MAX_RESULTS_LIMIT = 20

#: Hard ceiling on a response body, so a hostile or broken reply cannot exhaust memory.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class WebSearchError(Exception):
    """A search that could not be completed, with a message safe to show a user."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def resolve_api_key(supplied: object) -> str:
    """The key to use, or raises.

    A key supplied by the page wins, because that is the one the user just typed into
    Settings. Otherwise the environment is consulted, which lets somebody keep the key
    out of the browser and out of ``localStorage`` altogether.
    """
    if isinstance(supplied, str) and supplied.strip():
        return supplied.strip()
    from_env = os.environ.get(TAVILY_ENV_VAR, "")
    if from_env.strip():
        return from_env.strip()
    raise WebSearchError(
        f"No Tavily API key. Set one in Ideno's Settings, or put it in the "
        f"{TAVILY_ENV_VAR} environment variable before starting the desktop app."
    )


def build_body(payload: dict[str, Any]) -> dict[str, Any]:
    """Builds the request body from a validated subset of the payload.

    ``query`` is required and bounded. Only known option names are copied through, so a
    payload cannot introduce parameters this host has not decided to allow.
    """
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        raise WebSearchError("The search payload had no query.")
    query = query.strip()
    if len(query) > 400:
        # Tavily documents a 400-character query; truncating silently would search for
        # something other than what was asked, so the caller is told instead.
        raise WebSearchError("The search query is longer than 400 characters.")

    raw_max = payload.get("max_results", 5)
    try:
        max_results = int(raw_max)
    except (TypeError, ValueError):
        max_results = 5
    max_results = max(1, min(MAX_RESULTS_LIMIT, max_results))

    body: dict[str, Any] = {
        "query": query,
        "max_results": max_results,
        "search_depth": "basic",
        "topic": "general",
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
    }

    depth = payload.get("search_depth")
    if depth in ("basic", "advanced"):
        body["search_depth"] = depth
    topic = payload.get("topic")
    if topic in ("general", "news"):
        body["topic"] = topic

    # `include_answer`, `include_raw_content` and `include_images` are deliberately not
    # forwarded from the payload. Ideno never records a synthesised answer as evidence,
    # and building a citation needs neither raw page text nor images, so there is no
    # reason to let a caller switch them on and pay for the extra data.

    return body


def search(payload: dict[str, Any], timeout_seconds: float = 20.0) -> str:
    """Runs one Tavily search and returns the response body as a JSON string.

    Raises :class:`WebSearchError` with a message that is safe to display. No exception
    from ``urllib`` escapes, and no message includes the API key.
    """
    api_key = resolve_api_key(payload.get("api_key"))
    body = build_body(payload)

    timeout = timeout_seconds
    raw_timeout = payload.get("timeout_ms")
    if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
        timeout = max(1.0, min(120.0, float(raw_timeout) / 1000.0))

    request = urllib.request.Request(
        TAVILY_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            # Identifies the caller in Tavily's logs. Not a secret.
            "User-Agent": "Ideno/0.2 (desktop host)",
        },
        method="POST",
    )

    try:
        # The URL is a module constant, not caller input: see the note at the top of
        # this file on why that is the security property the whole module rests on.
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        detail = _safe_detail(error)
        raise WebSearchError(_status_message(error.code, detail)) from None
    except urllib.error.URLError as error:
        # A DNS or connection failure. Named as such so it is not mistaken for a
        # rejected key.
        raise WebSearchError(
            f"Tavily could not be reached from this machine ({error.reason}). "
            "Check the network connection."
        ) from None
    except TimeoutError as error:
        raise WebSearchError(f"Tavily did not respond within {timeout:.0f} seconds.") from None
    except OSError as error:
        raise WebSearchError(f"The search request failed ({error}).") from None

    if len(raw) > MAX_RESPONSE_BYTES:
        raise WebSearchError("Tavily returned more data than Ideno will read.")

    # Re-serialised rather than passed through verbatim: parsing first proves the reply
    # is JSON, and drops anything that is not an object at the top level.
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError) as error:
        raise WebSearchError(f"Tavily's reply was not valid JSON ({error}).") from None
    if not isinstance(parsed, dict):
        raise WebSearchError("Tavily's reply was not a JSON object.")

    return json.dumps(parsed)


def _safe_detail(error: urllib.error.HTTPError) -> str:
    """The server's own error text, bounded, with no header content.

    Headers are excluded on purpose: an ``Authorization`` echo or a set-cookie would be
    neither useful nor safe to surface.
    """
    try:
        raw = error.read(2048)
    except OSError:
        return ""
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:  # pragma: no cover - decode with errors="replace" does not raise
        return ""
    text = " ".join(text.split())
    # Tavily reports errors as {"detail": "..."}; the detail alone is the useful part.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            detail = parsed.get("detail") or parsed.get("message") or parsed.get("error")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()[:240]
    except ValueError:
        pass
    return text[:240]


def _status_message(status: int, detail: str) -> str:
    """Maps a status to the fix that applies. A bare code would be honest but useless."""
    suffix = f" Tavily said: {detail}" if detail else ""
    if status in (401, 403):
        return (
            f"Tavily rejected the API key (HTTP {status}). Check it in Settings — a key "
            f"that has been rotated or revoked fails here.{suffix}"
        )
    if status == 429:
        return f"Tavily rate-limited this request (HTTP 429). Wait a moment and try again.{suffix}"
    if status in (432, 433):
        return (
            f"Tavily refused the request against this account's limits (HTTP {status}). This "
            f"usually means the credit balance or plan cap has been reached.{suffix}"
        )
    if status in (400, 422):
        return f"Tavily rejected the request as malformed (HTTP {status}).{suffix}"
    if status >= 500:
        return (
            f"Tavily's servers returned HTTP {status}. Nothing was wrong on this side; "
            f"try again.{suffix}"
        )
    return f"Tavily returned HTTP {status}.{suffix}"
