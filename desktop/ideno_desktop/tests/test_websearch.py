"""The host-side web search.

Two properties matter here and both are security properties:

*   **This is not a proxy.** The method accepts a query, never a destination. A bridge
    that took a URL would let whatever runs in the page reach the loopback interface,
    cloud metadata endpoints and anything else the user's machine can see.
*   **Nothing raises across the bridge, and no message contains the API key.**
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from .. import websearch
from ..bridge import IdenoApi
from ..storage import FileStore

KEY = "tvly-test-key-not-a-secret-in-tests"


def payload(**overrides: object) -> str:
    body = {
        "query": "twin-wall polycarbonate price",
        "max_results": 3,
        "search_depth": "basic",
        "topic": "general",
    }
    body.update(overrides)
    return json.dumps({"provider": "tavily", "body": body, "api_key": KEY, "timeout_ms": 5000})


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self, limit: int = -1) -> bytes:
        return self._body if limit < 0 else self._body[:limit]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


class BuildBody(unittest.TestCase):
    def test_only_known_options_are_forwarded(self) -> None:
        body = websearch.build_body(
            {
                "query": "q",
                "max_results": 4,
                "search_depth": "advanced",
                "topic": "news",
                # None of these may be switched on by a caller: Ideno never stores a
                # synthesised answer as evidence and needs no raw page text.
                "include_answer": True,
                "include_raw_content": True,
                "include_images": True,
                "unknown_option": "surprise",
            }
        )
        self.assertEqual(body["query"], "q")
        self.assertEqual(body["max_results"], 4)
        self.assertEqual(body["search_depth"], "advanced")
        self.assertEqual(body["topic"], "news")
        self.assertFalse(body["include_answer"])
        self.assertFalse(body["include_raw_content"])
        self.assertFalse(body["include_images"])
        self.assertNotIn("unknown_option", body)

    def test_unknown_enum_values_fall_back_to_the_documented_default(self) -> None:
        body = websearch.build_body({"query": "q", "search_depth": "turbo", "topic": "sports"})
        self.assertEqual(body["search_depth"], "basic")
        self.assertEqual(body["topic"], "general")

    def test_results_are_bounded(self) -> None:
        self.assertEqual(websearch.build_body({"query": "q", "max_results": 999})["max_results"], 20)
        self.assertEqual(websearch.build_body({"query": "q", "max_results": 0})["max_results"], 1)
        self.assertEqual(websearch.build_body({"query": "q", "max_results": "many"})["max_results"], 5)

    def test_a_missing_or_overlong_query_is_refused(self) -> None:
        for bad in ({}, {"query": ""}, {"query": "   "}, {"query": 42}, {"query": None}):
            with self.assertRaises(websearch.WebSearchError):
                websearch.build_body(bad)
        with self.assertRaises(websearch.WebSearchError) as caught:
            websearch.build_body({"query": "x" * 401})
        self.assertIn("400 characters", caught.exception.message)


class ResolveKey(unittest.TestCase):
    def test_a_supplied_key_wins(self) -> None:
        with mock.patch.dict("os.environ", {websearch.TAVILY_ENV_VAR: "tvly-from-env"}):
            self.assertEqual(websearch.resolve_api_key("tvly-supplied"), "tvly-supplied")

    def test_the_environment_is_used_when_the_page_supplies_none(self) -> None:
        with mock.patch.dict("os.environ", {websearch.TAVILY_ENV_VAR: "tvly-from-env"}):
            self.assertEqual(websearch.resolve_api_key(None), "tvly-from-env")
            self.assertEqual(websearch.resolve_api_key("   "), "tvly-from-env")

    def test_no_key_anywhere_is_an_actionable_error(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(websearch.WebSearchError) as caught:
                websearch.resolve_api_key(None)
        self.assertIn(websearch.TAVILY_ENV_VAR, caught.exception.message)
        self.assertIn("Settings", caught.exception.message)


class Search(unittest.TestCase):
    def test_posts_to_the_one_endpoint_it_knows(self) -> None:
        body = json.dumps({"query": "x", "results": [{"title": "T", "url": "https://e.org/a"}]}).encode()
        with mock.patch.object(websearch.urllib.request, "urlopen", return_value=FakeResponse(body)) as opener:
            out = json.loads(websearch.search({"query": "x", "api_key": KEY}))

        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, websearch.TAVILY_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {KEY}")
        self.assertEqual(out["results"][0]["url"], "https://e.org/a")

    def test_the_timeout_is_bounded_in_both_directions(self) -> None:
        body = json.dumps({"results": []}).encode()
        with mock.patch.object(websearch.urllib.request, "urlopen", return_value=FakeResponse(body)) as opener:
            websearch.search({"query": "x", "api_key": KEY, "timeout_ms": 999_999})
            self.assertLessEqual(opener.call_args.kwargs["timeout"], 120.0)
            websearch.search({"query": "x", "api_key": KEY, "timeout_ms": 1})
            self.assertGreaterEqual(opener.call_args.kwargs["timeout"], 1.0)

    def test_an_http_error_becomes_a_message_with_the_fix_in_it(self) -> None:
        cases = {
            401: "rejected the API key",
            429: "rate-limited",
            432: "credit balance",
            500: "servers returned HTTP 500",
        }
        for status, expected in cases.items():
            error = urllib.error.HTTPError(
                websearch.TAVILY_URL, status, "err", {}, io.BytesIO(b'{"detail":"nope"}')
            )
            with mock.patch.object(websearch.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(websearch.WebSearchError) as caught:
                    websearch.search({"query": "x", "api_key": KEY})
            self.assertIn(expected, caught.exception.message)
            self.assertNotIn(KEY, caught.exception.message)

    def test_a_network_failure_is_named_as_one_not_as_a_bad_key(self) -> None:
        error = urllib.error.URLError("Name or service not known")
        with mock.patch.object(websearch.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(websearch.WebSearchError) as caught:
                websearch.search({"query": "x", "api_key": KEY})
        self.assertIn("could not be reached", caught.exception.message)

    def test_a_reply_that_is_not_json_is_refused(self) -> None:
        with mock.patch.object(
            websearch.urllib.request, "urlopen", return_value=FakeResponse(b"<html>nope</html>")
        ):
            with self.assertRaises(websearch.WebSearchError) as caught:
                websearch.search({"query": "x", "api_key": KEY})
        self.assertIn("not valid JSON", caught.exception.message)

    def test_a_reply_that_is_not_an_object_is_refused(self) -> None:
        with mock.patch.object(websearch.urllib.request, "urlopen", return_value=FakeResponse(b"[1,2,3]")):
            with self.assertRaises(websearch.WebSearchError):
                websearch.search({"query": "x", "api_key": KEY})

    def test_an_oversized_reply_is_refused_rather_than_read(self) -> None:
        huge = b"{" + b" " * (websearch.MAX_RESPONSE_BYTES + 2) + b"}"
        with mock.patch.object(websearch.urllib.request, "urlopen", return_value=FakeResponse(huge)):
            with self.assertRaises(websearch.WebSearchError) as caught:
                websearch.search({"query": "x", "api_key": KEY})
        self.assertIn("more data than Ideno will read", caught.exception.message)


class BridgeWebSearch(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.api = IdenoApi(FileStore(Path(self._tmp.name) / "workspace"), "0.2.0")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_good_search_comes_back_as_json_text(self) -> None:
        body = json.dumps({"results": [{"title": "T", "url": "https://e.org/a", "score": 0.9}]}).encode()
        with mock.patch.object(websearch.urllib.request, "urlopen", return_value=FakeResponse(body)):
            out = self.api.web_search(payload())

        self.assertTrue(out["ok"])
        parsed = json.loads(out["value"])
        self.assertEqual(parsed["results"][0]["url"], "https://e.org/a")

    def test_a_search_failure_is_reported_not_raised(self) -> None:
        error = urllib.error.HTTPError(websearch.TAVILY_URL, 401, "err", {}, io.BytesIO(b"{}"))
        with mock.patch.object(websearch.urllib.request, "urlopen", side_effect=error):
            out = self.api.web_search(payload())
        self.assertFalse(out["ok"])
        self.assertIn("rejected the API key", out["error"])
        self.assertNotIn(KEY, str(out["error"]))

    def test_an_unexpected_exception_still_comes_back_as_a_failure(self) -> None:
        with mock.patch.object(websearch, "search", side_effect=RuntimeError("boom")):
            out = self.api.web_search(payload())
        self.assertFalse(out["ok"])
        self.assertEqual(out["kind"], "internal")
        # The message names the exception type without echoing its text, which is where
        # a key would be if anything had interpolated one into it.
        self.assertNotIn("boom", str(out["error"]))

    def test_a_payload_that_is_not_json_is_refused(self) -> None:
        self.assertFalse(self.api.web_search("{not json")["ok"])
        self.assertFalse(self.api.web_search("[1,2]")["ok"])
        self.assertFalse(self.api.web_search(42)["ok"])  # type: ignore[arg-type]

    def test_an_oversized_payload_is_refused_before_it_is_parsed(self) -> None:
        out = self.api.web_search("x" * (64 * 1024 + 10))
        self.assertFalse(out["ok"])
        self.assertIn("too large", out["error"])

    def test_only_tavily_is_accepted_so_this_cannot_become_a_general_proxy(self) -> None:
        body = json.dumps({"provider": "anything", "body": {"query": "x"}, "api_key": KEY})
        out = self.api.web_search(body)
        self.assertFalse(out["ok"])
        self.assertIn("Unsupported search provider", out["error"])

    def test_a_destination_in_the_payload_is_ignored_not_visited(self) -> None:
        """The core security property: the URL is a module constant, never caller input."""
        hostile = json.dumps(
            {
                "provider": "tavily",
                # A caller trying to aim this host at the metadata endpoint, or at
                # anything else on the local network, gets the one URL this module knows.
                "url": "http://169.254.169.254/latest/meta-data/",
                "endpoint": "http://127.0.0.1:9999/",
                "body": {"query": "x", "url": "http://169.254.169.254/"},
                "api_key": KEY,
            }
        )
        with mock.patch.object(
            websearch.urllib.request, "urlopen", return_value=FakeResponse(json.dumps({"results": []}).encode())
        ) as opener:
            out = self.api.web_search(hostile)

        self.assertTrue(out["ok"])
        self.assertEqual(opener.call_args.args[0].full_url, websearch.TAVILY_URL)

    def test_a_missing_body_is_refused(self) -> None:
        out = self.api.web_search(json.dumps({"provider": "tavily", "api_key": KEY}))
        self.assertFalse(out["ok"])
        self.assertIn("no request body", out["error"])


if __name__ == "__main__":
    unittest.main()
