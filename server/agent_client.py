"""Bounded HTTP adapter for the optional CET Agent runtime.

The main server deliberately remains usable without LangGraph or any other
agent dependency.  When ``CET_AGENT_URL`` is configured, this adapter sends
already-resolved, revision-pinned exam context to a separately managed Python
3.11 service.  Every response is treated as untrusted input and validated
before it can be exposed through the platform API.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener


# Keep this above the sidecar's bounded model timeout (25 seconds) so a slow
# model returns through the Agent's conservative fallback instead of causing a
# second direct model request while the first one is still running.
DEFAULT_TIMEOUT_SECONDS = 40.0
MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_REPLY_CHARS = 64_000
MAX_COLLECTION_ITEMS = 100

SUPPORTED_TUTOR_SCHEMAS = frozenset({"cet-agent-tutor/1", "cet-agent-tutor/2"})
SUPPORTED_HEALTH_SCHEMAS = frozenset({"cet-agent-health/1", "cet-agent-health/2"})
SUPPORTED_GENERATION_PROVIDERS = frozenset({"deepseek", "deterministic"})
SUPPORTED_FALLBACK_REASONS = frozenset(
    {
        "not_configured",
        "invalid_configuration",
        "blocked_mutation",
        "upstream_timeout",
        "upstream_auth_error",
        "upstream_insufficient_balance",
        "upstream_rate_limited",
        "upstream_request_error",
        "upstream_server_error",
        "upstream_response_truncated",
        "invalid_response",
        "agent_transport_error",
    }
)
TOOL_NAMES = frozenset({"get_current_question", "get_answer_record", "retrieve_evidence", "retrieve_methods", "retrieve_personal_notes", "compare_options"})
PROGRESS_NODES = frozenset({"route_intent", "read_context_tools", "retrieve_grounded_evidence", "draft_grounded_reply", "model_decision", "execute_context_tools", "grounding_guard", "finalize_tutor", "memory_load", "memory_save"})
STOP_REASONS = frozenset({"final", "not_configured", "invalid_configuration", "blocked_mutation", "round_budget", "token_budget", "time_budget", "cancelled", "invalid_tool_call", "upstream_error"})
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class _NoCredentialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Agent redirects are disabled", headers, fp)


def urlopen(request: Request, *, timeout: float):
    """Keep the public mock seam, never proxy loopback or forward Bearer tokens."""
    host = urlparse(request.full_url).hostname
    proxy = ProxyHandler({}) if host in {"127.0.0.1", "localhost", "::1"} else ProxyHandler()
    return build_opener(proxy, _NoCredentialRedirect()).open(request, timeout=timeout)


class AgentClientError(RuntimeError):
    """Base error raised by the optional Agent adapter."""


class AgentUnavailable(AgentClientError):
    """The Agent runtime is disabled, unreachable, or not ready."""


class AgentProtocolError(AgentClientError):
    """The Agent runtime returned a response outside the fixed contract."""


def _environment_timeout(value: object) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    if not math.isfinite(timeout) or timeout < 0.2 or timeout > 120:
        return DEFAULT_TIMEOUT_SECONDS
    return timeout


def _validated_endpoint(value: str) -> str:
    endpoint = value.strip()
    if not endpoint:
        return ""
    parsed = urlparse(endpoint)
    try:
        hostname = parsed.hostname
        parsed.port
    except ValueError as error:
        raise AgentUnavailable("CET_AGENT_URL contains an invalid host or port") from error
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise AgentUnavailable("CET_AGENT_URL must be an HTTP(S) origin without credentials or a path")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def _validated_token(value: str) -> str:
    token = value.strip()
    if len(token) > 4_096 or any(ord(character) < 0x21 or ord(character) == 0x7F for character in token):
        raise AgentUnavailable("CET_AGENT_TOKEN contains unsupported characters")
    return token


def _text(value: object, context: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise AgentProtocolError(f"{context} must be text")
    cleaned = value.strip()
    if (not cleaned and not allow_empty) or len(cleaned) > maximum:
        raise AgentProtocolError(f"{context} is empty or too long")
    return cleaned


def _integer(value: object, context: str, *, minimum: int = 0, maximum: int = 2_147_483_647) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise AgentProtocolError(f"{context} must be an integer between {minimum} and {maximum}")
    return value


def _strict_object(
    value: object,
    context: str,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AgentProtocolError(f"{context} must be an object")
    fields = set(value)
    optional = optional or set()
    missing = required - fields
    unknown = fields - required - optional
    if missing or unknown:
        raise AgentProtocolError(f"{context} has an invalid schema")
    return value


def _string_list(value: object, context: str, maximum_items: int = MAX_COLLECTION_ITEMS) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise AgentProtocolError(f"{context} must be a bounded list")
    return [_text(item, f"{context}[{index}]", 2_000) for index, item in enumerate(value)]


def _validate_trace(value: object) -> dict[str, object]:
    trace = _strict_object(value, "trace", {"nodes", "durationMs"})
    nodes = _string_list(trace["nodes"], "trace.nodes", 64)
    duration = _integer(trace["durationMs"], "trace.durationMs", maximum=86_400_000)
    return {"nodes": nodes, "durationMs": duration}


def _validate_generation(value: object) -> dict[str, object]:
    """Validate the versioned model-generation metadata (tutor schema /2)."""

    generation = _strict_object(
        value,
        "generation",
        {"provider", "model", "attempted", "used", "fallbackReason", "usage"},
    )
    provider = generation["provider"]
    model = generation["model"]
    attempted = generation["attempted"]
    used = generation["used"]
    fallback_reason = generation["fallbackReason"]
    usage = generation["usage"]
    if (
        not isinstance(provider, str)
        or provider not in SUPPORTED_GENERATION_PROVIDERS
        or type(attempted) is not bool
        or type(used) is not bool
        or not (model is None or isinstance(model, str))
        or not (fallback_reason is None or fallback_reason in SUPPORTED_FALLBACK_REASONS)
    ):
        raise AgentProtocolError("generation has an invalid schema")
    if model is not None and (not isinstance(model, str) or len(model) > 160):
        raise AgentProtocolError("generation.model is invalid")
    if used and (provider != "deepseek" or not model):
        raise AgentProtocolError("generation.used requires a deepseek provider and model")
    if not used and usage is not None:
        raise AgentProtocolError("generation.usage is only allowed when a model was used")
    if usage is None:
        return {
            "provider": provider,
            "model": model,
            "attempted": attempted,
            "used": used,
            "fallbackReason": fallback_reason,
            "usage": None,
        }
    usage_fields = _strict_object(usage, "generation.usage", {"promptTokens", "completionTokens", "totalTokens"})
    sanitized_usage: dict[str, int] = {}
    for field in ("promptTokens", "completionTokens", "totalTokens"):
        number = usage_fields[field]
        if isinstance(number, bool) or not isinstance(number, int) or not 0 <= number < 10_000_000:
            raise AgentProtocolError(f"generation.usage.{field} is invalid")
        sanitized_usage[field] = number
    return {
        "provider": provider,
        "model": model,
        "attempted": attempted,
        "used": used,
        "fallbackReason": fallback_reason,
        "usage": sanitized_usage,
    }


def _validate_execution(value: object) -> dict[str, object]:
    execution = _strict_object(value, "execution", {"mode", "rounds", "toolCalls", "stopReason", "budget"})
    if not isinstance(execution["mode"], str) or not isinstance(execution["stopReason"], str) or execution["mode"] not in {"dynamic_tools", "deterministic"} or execution["stopReason"] not in STOP_REASONS:
        raise AgentProtocolError("execution has invalid mode or stop reason")
    budget = _strict_object(execution["budget"], "execution.budget", {"maxRounds", "maxToolCalls", "maxTokens", "maxSeconds"})
    # The sidecar cannot loosen runtime budgets in an untrusted response.
    expected = {"maxRounds": 4, "maxToolCalls": 12, "maxTokens": 8000, "maxSeconds": 30}
    if any(type(budget[key]) is not int or budget[key] != number for key, number in expected.items()):
        raise AgentProtocolError("execution.budget is invalid")
    rounds = _integer(execution["rounds"], "execution.rounds", maximum=4)
    calls = _integer(execution["toolCalls"], "execution.toolCalls", maximum=12)
    if execution["mode"] == "deterministic" and (rounds or calls):
        raise AgentProtocolError("deterministic execution must not claim model rounds")
    return {"mode": execution["mode"], "rounds": rounds, "toolCalls": calls, "stopReason": execution["stopReason"], "budget": expected}


def _validate_memory(value: object, conversation_id: str = "") -> dict[str, object]:
    memory = _strict_object(value, "memory", {"enabled", "conversationId", "turns", "summaryPresent", "scopeReset"})
    if any(type(memory[key]) is not bool for key in ("enabled", "summaryPresent", "scopeReset")):
        raise AgentProtocolError("memory has invalid boolean fields")
    if memory["conversationId"] != (conversation_id or None) or memory["enabled"] != bool(conversation_id):
        raise AgentProtocolError("memory does not match requested conversation")
    turns = _integer(memory["turns"], "memory.turns", maximum=6)
    if not memory["enabled"] and (turns or memory["summaryPresent"] or memory["scopeReset"]):
        raise AgentProtocolError("disabled memory has inconsistent fields")
    return {**memory, "turns": turns}


def _validate_citations(value: object, context: str = "citations") -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > MAX_COLLECTION_ITEMS:
        raise AgentProtocolError(f"{context} must be a bounded list")
    citations: list[dict[str, object]] = []
    for index, raw in enumerate(value):
        citation = _strict_object(
            raw,
            f"{context}[{index}]",
            {"source", "questionId", "excerpt"},
            {"page"},
        )
        normalized: dict[str, object] = {
            "source": _text(citation["source"], f"{context}[{index}].source", 160),
            "questionId": _text(citation["questionId"], f"{context}[{index}].questionId", 32),
            "excerpt": _text(citation["excerpt"], f"{context}[{index}].excerpt", 4_000),
        }
        if "page" in citation:
            normalized["page"] = _integer(citation["page"], f"{context}[{index}].page", minimum=1, maximum=999)
        citations.append(normalized)
    return citations


def _validate_run_identity(document: Mapping[str, object]) -> tuple[str, str]:
    run_id = _text(document.get("runId"), "runId", 128)
    thread_id = _text(document.get("threadId"), "threadId", 128)
    if document.get("status") != "completed":
        raise AgentProtocolError("Agent response status must be completed")
    return run_id, thread_id


def _validate_proposal_value(entity: str, field: str, value: object, context: str) -> object:
    if field in {"stem", "type", "answer", "explanation"}:
        maximum = 12_000 if field in {"stem", "explanation"} else 64
        text = _text(value, f"{context}.value", maximum, allow_empty=field == "explanation")
        if field == "type" and text not in {
            "single_choice", "matching", "writing", "translation", "unknown"
        }:
            raise AgentProtocolError(f"{context}.value is not a supported question type")
        if field == "answer" and (len(text) != 1 or text.upper() not in "ABCDEFGHIJKLMNO"):
            raise AgentProtocolError(f"{context}.value is not a supported objective answer")
        return text.upper() if field == "answer" else text
    if field == "page":
        return _integer(value, f"{context}.value", minimum=1, maximum=999)
    if field == "bbox":
        box = _strict_object(value, f"{context}.value", {"x", "y", "width", "height"})
        normalized: dict[str, float] = {}
        for name in ("x", "y", "width", "height"):
            raw = box[name]
            if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)):
                raise AgentProtocolError(f"{context}.value.{name} must be finite")
            number = float(raw)
            if (name in {"x", "y"} and number < 0) or (name in {"width", "height"} and number <= 0):
                raise AgentProtocolError(f"{context}.value.{name} is outside the supported range")
            normalized[name] = number
        return normalized
    if field == "options":
        if not isinstance(value, list) or not 1 <= len(value) <= 15:
            raise AgentProtocolError(f"{context}.value must be a bounded option list")
        options: list[dict[str, str]] = []
        labels: set[str] = set()
        for index, raw in enumerate(value):
            option = _strict_object(raw, f"{context}.value[{index}]", {"label", "text"})
            label = _text(option["label"], f"{context}.value[{index}].label", 1).upper()
            if label not in "ABCDEFGHIJKLMNO" or label in labels:
                raise AgentProtocolError(f"{context}.value contains an invalid option label")
            labels.add(label)
            options.append({
                "label": label,
                "text": _text(option["text"], f"{context}.value[{index}].text", 4_000),
            })
        return options
    raise AgentProtocolError(f"{context}.field is unsupported for {entity}")


@dataclass(frozen=True)
class AgentClient:
    """Dependency-free client for the optional Agent orchestration sidecar."""

    endpoint: str
    token: str = ""
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_environment(cls) -> "AgentClient":
        return cls(
            endpoint=_validated_endpoint(os.environ.get("CET_AGENT_URL", "")),
            token=_validated_token(os.environ.get("CET_AGENT_TOKEN", "")),
            timeout_seconds=_environment_timeout(
                os.environ.get("CET_AGENT_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))
            ),
        )

    @property
    def configured(self) -> bool:
        return bool(self.endpoint)

    def _request(
        self,
        path: str,
        *,
        method: str,
        payload: Mapping[str, object] | None = None,
        timeout_seconds: float | None = None,
        maximum_response_bytes: int = MAX_RESPONSE_BYTES,
    ) -> dict[str, object]:
        if not self.configured:
            raise AgentUnavailable("CET_AGENT_URL is not configured")
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": "cet-reading-lab-agent-adapter/1",
        }
        if payload is not None:
            try:
                data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, RecursionError) as error:
                raise AgentClientError("Agent request context is not JSON serializable") from error
            if len(data) > MAX_REQUEST_BYTES:
                raise AgentClientError("Agent request context is too large")
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            request = Request(f"{self.endpoint}{path}", data=data, headers=headers, method=method)
        except ValueError as error:
            raise AgentUnavailable("Agent runtime endpoint or authorization is invalid") from error
        timeout = self.timeout_seconds if timeout_seconds is None else _environment_timeout(timeout_seconds)
        try:
            with urlopen(request, timeout=timeout) as response:
                media_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                raw = response.read(maximum_response_bytes + 1)
        except HTTPError as error:
            try:
                error.read(4096)
            except OSError:
                pass
            raise AgentUnavailable(f"Agent runtime rejected the request with HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError) as error:
            raise AgentUnavailable("Agent runtime is temporarily unavailable") from error
        if media_type != "application/json" or len(raw) > maximum_response_bytes:
            raise AgentProtocolError("Agent response is not bounded JSON")
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise AgentProtocolError("Agent response is invalid JSON") from error
        if not isinstance(document, dict):
            raise AgentProtocolError("Agent response must be a JSON object")
        return document

    def health(self, timeout_seconds: float = 1.5) -> dict[str, object]:
        document = _strict_object(
            self._request(
                "/healthz",
                method="GET",
                timeout_seconds=max(0.2, min(float(timeout_seconds), 10.0)),
                maximum_response_bytes=16 * 1024,
            ),
            "Agent health response",
            {
                "schemaVersion",
                "service",
                "status",
                "ready",
                "engine",
                "pythonVersion",
                "langgraphImportReady",
                "checkpointReady",
                "deepseekConfigured",
                "detail",
            },
            {"deepseekKeyPresent", "deepseekModel", "streaming", "memory", "dynamicTools"},
        )
        if (
            document["schemaVersion"] not in SUPPORTED_HEALTH_SCHEMAS
            or document["service"] != "cet-agent-runtime"
            or not isinstance(document["status"], str)
            or document["status"] not in {"ok", "not_ready"}
            or document["engine"] != "langgraph"
            or type(document["ready"]) is not bool
            or type(document["langgraphImportReady"]) is not bool
            or type(document["checkpointReady"]) is not bool
            or type(document["deepseekConfigured"]) is not bool
            or bool(document["ready"]) != (document["status"] == "ok")
        ):
            raise AgentProtocolError("Agent health response has inconsistent readiness fields")
        deepseek_model: str | None = None
        if "deepseekModel" in document:
            if document["deepseekModel"] is not None:
                deepseek_model = _text(document["deepseekModel"], "deepseekModel", 160)
        key_present = False
        if "deepseekKeyPresent" in document:
            if type(document["deepseekKeyPresent"]) is not bool:
                raise AgentProtocolError("deepseekKeyPresent must be a boolean")
            key_present = bool(document["deepseekKeyPresent"])
        capabilities: dict[str, bool] = {}
        for field in ("streaming", "memory", "dynamicTools"):
            if field in document:
                if type(document[field]) is not bool or (document[field] and not document["ready"]):
                    raise AgentProtocolError(f"{field} must be a truthful readiness boolean")
                capabilities[field] = document[field]
        return {
            "schemaVersion": document["schemaVersion"],
            "service": document["service"],
            "status": document["status"],
            "ready": document["ready"],
            "engine": document["engine"],
            "pythonVersion": _text(document["pythonVersion"], "pythonVersion", 64),
            "langgraphImportReady": document["langgraphImportReady"],
            "checkpointReady": document["checkpointReady"],
            "deepseekConfigured": document["deepseekConfigured"],
            "deepseekKeyPresent": key_present,
            "deepseekModel": deepseek_model,
            "detail": _text(document["detail"], "detail", 500, allow_empty=True),
            **capabilities,
        }

    def tutor(self, payload: Mapping[str, object]) -> dict[str, object]:
        return self._validated_tutor(payload, lambda: self._request("/v1/tutor", method="POST", payload=payload))

    def _validated_tutor(self, payload: Mapping[str, object], read_document: object) -> dict[str, object]:
        expected_fields = {
            "examId", "questionId", "reviewRevision", "message", "userAnswer", "history", "context"
        }
        optional_fields = {"requestId", "conversationId"}
        if not set(payload) <= (expected_fields | optional_fields) or not expected_fields <= set(payload):
            raise AgentClientError("Agent tutor request has an invalid schema")
        request_id = ""
        if "requestId" in payload:
            raw_request_id = payload["requestId"]
            if (
                not isinstance(raw_request_id, str)
                or not raw_request_id.strip()
                or len(raw_request_id.strip()) > 128
            ):
                raise AgentClientError("Agent tutor requestId is invalid")
            request_id = raw_request_id.strip()
        conversation_id = ""
        if "conversationId" in payload:
            raw_id = payload["conversationId"]
            if not isinstance(raw_id, str) or not IDENTIFIER.fullmatch(raw_id):
                raise AgentClientError("Agent tutor conversationId is invalid")
            conversation_id = raw_id
        exam_id = str(payload["examId"])
        question_id = str(payload["questionId"])
        revision = payload["reviewRevision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise AgentClientError("Agent tutor reviewRevision is invalid")
        response_fields = {
            "schemaVersion", "runId", "threadId", "status", "examId", "questionId",
            "reviewRevision", "reply", "intent", "tools", "citations", "grounding", "trace",
        }
        document = _strict_object(
            read_document(),
            "Agent tutor response",
            response_fields,
            {"generation", "requestId", "execution", "memory"},
        )
        sent_request_id = request_id
        if sent_request_id and document.get("requestId") != sent_request_id:
            raise AgentProtocolError("Agent tutor response does not echo the request id")
        if (
            document["schemaVersion"] not in SUPPORTED_TUTOR_SCHEMAS
            or document["examId"] != exam_id
            or document["questionId"] != question_id
            or document["reviewRevision"] != revision
        ):
            raise AgentProtocolError("Agent tutor response does not match the requested exam revision")
        run_id, thread_id = _validate_run_identity(document)
        tools_value = document["tools"]
        if not isinstance(tools_value, list) or len(tools_value) > 64:
            raise AgentProtocolError("tools must be a bounded list")
        tools: list[dict[str, str]] = []
        for index, raw in enumerate(tools_value):
            tool = _strict_object(raw, f"tools[{index}]", {"name", "status"})
            if not isinstance(tool["status"], str) or tool["status"] not in {"completed", "skipped"}:
                raise AgentProtocolError(f"tools[{index}].status is invalid")
            tools.append({
                "name": _text(tool["name"], f"tools[{index}].name", 160),
                "status": str(tool["status"]),
            })
        grounding = _strict_object(
            document["grounding"],
            "grounding",
            {
                "status",
                "officialEvidenceFound",
                "disclaimerRequired",
                "officialExplanationFound",
                "exactMatches",
                "vectorMatches",
                "disclaimer",
                "retrievalOrder",
            },
        )
        if (
            not isinstance(grounding["status"], str)
            or grounding["status"] not in {"official", "context_only", "insufficient"}
            or type(grounding["officialEvidenceFound"]) is not bool
            or type(grounding["disclaimerRequired"]) is not bool
            or type(grounding["officialExplanationFound"]) is not bool
        ):
            raise AgentProtocolError("grounding has an invalid schema")
        retrieval_order = _string_list(grounding["retrievalOrder"], "grounding.retrievalOrder", 8)
        if retrieval_order != ["question_id_exact", "deterministic_vector_supplement"]:
            raise AgentProtocolError("grounding.retrievalOrder is invalid")
        result: dict[str, object] = {
            "schemaVersion": document["schemaVersion"],
            "runId": run_id,
            "threadId": thread_id,
            "status": "completed",
            "examId": exam_id,
            "questionId": question_id,
            "reviewRevision": revision,
            "reply": _text(document["reply"], "reply", MAX_REPLY_CHARS),
            "intent": _text(document["intent"], "intent", 160),
            "tools": tools,
            "citations": _validate_citations(document["citations"]),
            "grounding": {
                "status": grounding["status"],
                "officialEvidenceFound": grounding["officialEvidenceFound"],
                "disclaimerRequired": grounding["disclaimerRequired"],
                "officialExplanationFound": grounding["officialExplanationFound"],
                "exactMatches": _integer(grounding["exactMatches"], "grounding.exactMatches", maximum=10_000),
                "vectorMatches": _integer(grounding["vectorMatches"], "grounding.vectorMatches", maximum=10_000),
                "disclaimer": _text(
                    grounding["disclaimer"], "grounding.disclaimer", 2_000, allow_empty=True
                ),
                "retrievalOrder": retrieval_order,
            },
            "trace": _validate_trace(document["trace"]),
        }
        if sent_request_id:
            result["requestId"] = sent_request_id
        if "generation" in document:
            result["generation"] = _validate_generation(document["generation"])
        if "execution" in document:
            result["execution"] = _validate_execution(document["execution"])
        if "memory" in document:
            result["memory"] = _validate_memory(document["memory"], conversation_id)
        return result

    def tutor_stream(self, payload: Mapping[str, object], event_callback: object = None, cancel_event: object = None) -> dict[str, object]:
        """Consume a bounded SSE stream; no transparent second model request."""
        def read_document() -> dict[str, object]:
            if not self.configured:
                raise AgentUnavailable("CET_AGENT_URL is not configured")
            try:
                data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, RecursionError) as error:
                raise AgentClientError("Agent request context is not JSON serializable") from error
            if len(data) > MAX_REQUEST_BYTES:
                raise AgentClientError("Agent request context is too large")
            headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            request = Request(f"{self.endpoint}/v1/tutor/stream", data=data, headers=headers, method="POST")
            total = 0
            event_count = 0
            event_name = ""
            data_line = ""
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "text/event-stream":
                        raise AgentProtocolError("Agent stream is not SSE")
                    while True:
                        if cancel_event is not None and cancel_event.is_set():
                            raise AgentUnavailable("Agent request cancelled")
                        raw = response.readline(MAX_RESPONSE_BYTES + 1)
                        if not raw:
                            raise AgentProtocolError("Agent stream ended without a result")
                        total += len(raw)
                        if len(raw) > MAX_RESPONSE_BYTES or total > MAX_RESPONSE_BYTES * 2:
                            raise AgentProtocolError("Agent stream exceeds byte limit")
                        try:
                            line = raw.decode("utf-8").rstrip("\r\n")
                        except UnicodeDecodeError as error:
                            raise AgentProtocolError("Agent stream is not UTF-8") from error
                        if line.startswith("event: "):
                            if event_name:
                                raise AgentProtocolError("Duplicate SSE event field")
                            event_name = line[7:]
                        elif line.startswith("data: "):
                            if data_line:
                                raise AgentProtocolError("Multiline SSE payloads are unsupported")
                            data_line = line[6:]
                        elif line:
                            raise AgentProtocolError("Unsupported SSE field")
                        else:
                            event_count += 1
                            if event_count > 256 or not event_name or not data_line:
                                raise AgentProtocolError("Invalid SSE event")
                            try:
                                event = json.loads(data_line)
                            except (ValueError, RecursionError) as error:
                                raise AgentProtocolError("Invalid SSE JSON") from error
                            if not isinstance(event, dict) or event.get("type") != event_name:
                                raise AgentProtocolError("SSE event type mismatch")
                            if event_name == "metadata":
                                _strict_object(event, "stream metadata", {"type", "schemaVersion"})
                                if event["schemaVersion"] != "cet-agent-stream/1":
                                    raise AgentProtocolError("Unsupported stream schema")
                            elif event_name == "heartbeat":
                                _strict_object(event, "heartbeat", {"type"})
                            elif event_name == "progress":
                                _strict_object(event, "progress", {"type", "node"}, {"tool", "round"})
                                if not isinstance(event["node"], str) or event["node"] not in PROGRESS_NODES or ("tool" in event and (not isinstance(event["tool"], str) or event["tool"] not in TOOL_NAMES)):
                                    raise AgentProtocolError("Stream progress includes unsafe names")
                                if "round" in event:
                                    _integer(event["round"], "progress.round", maximum=4)
                                if event_callback is not None:
                                    event_callback(dict(event))
                            elif event_name == "result":
                                _strict_object(event, "stream result", {"type", "result"})
                                return event["result"]
                            elif event_name == "error":
                                _strict_object(event, "stream error", {"type", "error"})
                                detail = _strict_object(event["error"], "stream.error", {"code", "message"})
                                _text(detail["code"], "stream.error.code", 64)
                                _text(detail["message"], "stream.error.message", 256)
                                raise AgentUnavailable("Agent runtime reported a stream error")
                            else:
                                raise AgentProtocolError("Unsupported stream event")
                            event_name = data_line = ""
            except HTTPError as error:
                raise AgentUnavailable(f"Agent runtime rejected the stream with HTTP {error.code}") from error
            except (URLError, TimeoutError, OSError) as error:
                raise AgentUnavailable("Agent stream is temporarily unavailable") from error
        return self._validated_tutor(payload, read_document)

    def clear_conversation(self, payload: Mapping[str, object]) -> dict[str, object]:
        if set(payload) != {"examId", "questionId", "conversationId"} or any(
            not isinstance(payload[field], str) or not IDENTIFIER.fullmatch(payload[field]) for field in payload
        ):
            raise AgentClientError("Agent conversation clear request is invalid")
        document = _strict_object(self._request("/v1/conversations/clear", method="POST", payload=payload),
                                  "memory clear response", {"schemaVersion", "conversationId", "cleared"})
        if document["schemaVersion"] != "cet-agent-memory/1" or document["conversationId"] != payload["conversationId"] or type(document["cleared"]) is not bool:
            raise AgentProtocolError("Memory clear response is invalid")
        return dict(document)

    def suggest_review(self, payload: Mapping[str, object]) -> dict[str, object]:
        if set(payload) != {"examId", "reviewRevision", "issue", "context"}:
            raise AgentClientError("Agent review request has an invalid schema")
        exam_id = str(payload["examId"])
        revision = payload["reviewRevision"]
        issue = payload["issue"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise AgentClientError("Agent review reviewRevision is invalid")
        if (
            not isinstance(issue, dict)
            or set(issue) != {"issueId", "kind", "targetId", "message", "severity", "page"}
        ):
            raise AgentClientError("Agent review issue is invalid")
        issue_id = str(issue.get("issueId") or "")
        target_id = str(issue.get("targetId") or "")
        if not issue_id or not target_id:
            raise AgentClientError("Agent review issue identity is invalid")
        document = _strict_object(
            self._request("/v1/review/suggest", method="POST", payload=payload),
            "Agent review response",
            {
                "schemaVersion", "runId", "threadId", "status", "policy", "examId",
                "reviewRevision", "issueId", "proposals", "rationale", "evidence",
                "cautions", "trace",
            },
        )
        if (
            document["schemaVersion"] != "cet-agent-review-suggestion/1"
            or document["policy"] != "suggest_only"
            or document["examId"] != exam_id
            or document["reviewRevision"] != revision
            or document["issueId"] != issue_id
        ):
            raise AgentProtocolError("Agent review response does not match the requested issue revision")
        run_id, thread_id = _validate_run_identity(document)
        proposals_value = document["proposals"]
        if not isinstance(proposals_value, list) or len(proposals_value) > MAX_COLLECTION_ITEMS:
            raise AgentProtocolError("proposals must be a bounded list")
        proposals: list[dict[str, object]] = []
        allowed_fields = {
            "question": {"stem", "type", "page", "bbox", "options"},
            "answer": {"answer", "explanation"},
        }
        for index, raw in enumerate(proposals_value):
            proposal = _strict_object(
                raw,
                f"proposals[{index}]",
                {"op", "entity", "questionId", "field", "value", "confidence", "evidenceSources"},
            )
            confidence = proposal["confidence"]
            entity = proposal["entity"]
            field = proposal["field"]
            if (
                proposal["op"] != "replace"
                or not isinstance(entity, str)
                or not isinstance(field, str)
                or entity not in allowed_fields
                or field not in allowed_fields[str(entity)]
                or proposal["questionId"] != target_id
                or isinstance(confidence, bool)
                or not isinstance(confidence, (int, float))
                or not math.isfinite(float(confidence))
                or not 0 <= float(confidence) <= 1
            ):
                raise AgentProtocolError(f"proposals[{index}] is invalid")
            normalized_value = _validate_proposal_value(
                str(entity), str(field), proposal["value"], f"proposals[{index}]"
            )
            # Round-trip the proposed value to keep nested JSON bounded.
            try:
                encoded_value = json.dumps(normalized_value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, RecursionError) as error:
                raise AgentProtocolError(f"proposals[{index}].value is invalid") from error
            if len(encoded_value) > 64 * 1024:
                raise AgentProtocolError(f"proposals[{index}].value is too large")
            proposals.append({
                "op": "replace",
                "entity": entity,
                "questionId": target_id,
                "field": field,
                "value": normalized_value,
                "confidence": round(float(confidence), 4),
                "evidenceSources": _string_list(
                    proposal["evidenceSources"], f"proposals[{index}].evidenceSources", 32
                ),
            })
        return {
            "schemaVersion": document["schemaVersion"],
            "runId": run_id,
            "threadId": thread_id,
            "status": "completed",
            "policy": "suggest_only",
            "examId": exam_id,
            "reviewRevision": revision,
            "issueId": issue_id,
            "proposals": proposals,
            "rationale": _text(document["rationale"], "rationale", 12_000),
            "evidence": _validate_citations(document["evidence"], "evidence"),
            "cautions": _string_list(document["cautions"], "cautions", 64),
            "trace": _validate_trace(document["trace"]),
        }
