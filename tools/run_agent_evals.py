#!/usr/bin/env python3
"""Run deterministic contract evals against the optional CET Agent runtime."""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = PROJECT_ROOT / "evals" / "agent_cases.jsonl"
MAX_CASES = 200
MAX_RESPONSE_BYTES = 512 * 1024
ALLOWED_ENDPOINTS = {"/v1/tutor", "/v1/review/suggest"}


class EvalError(RuntimeError):
    pass


def _origin(value: str) -> str:
    parsed = urlparse(value.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise EvalError("Agent endpoint must be an HTTP(S) origin without credentials or a path")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise EvalError(f"Unable to read eval cases: {error}") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvalError(f"Invalid JSON on line {line_number}: {error.msg}") from error
        if not isinstance(case, dict) or set(case) != {"caseId", "endpoint", "request", "expect"}:
            raise EvalError(f"Line {line_number} must contain only caseId, endpoint, request, and expect")
        case_id = case["caseId"]
        if not isinstance(case_id, str) or not case_id or len(case_id) > 100 or case_id in seen:
            raise EvalError(f"Line {line_number} has an invalid or duplicate caseId")
        if case["endpoint"] not in ALLOWED_ENDPOINTS:
            raise EvalError(f"Line {line_number} uses an unsupported endpoint")
        if not isinstance(case["request"], dict) or not isinstance(case["expect"], dict):
            raise EvalError(f"Line {line_number} request and expect must be objects")
        seen.add(case_id)
        cases.append(case)
        if len(cases) > MAX_CASES:
            raise EvalError(f"Eval suite may contain at most {MAX_CASES} cases")
    if not cases:
        raise EvalError("Eval suite is empty")
    return cases


def _contains_all(value: str, fragments: Any) -> bool:
    return isinstance(fragments, list) and all(isinstance(item, str) and item in value for item in fragments)


def evaluate_response(case: dict[str, Any], document: Any) -> list[str]:
    expect = case["expect"]
    failures: list[str] = []
    if not isinstance(document, dict):
        return ["response is not an object"]
    for field in ("schemaVersion", "status", "examId", "reviewRevision", "trace"):
        if field not in document:
            failures.append(f"missing {field}")
    if document.get("status") != "completed":
        failures.append("status is not completed")
    if document.get("examId") != case["request"].get("examId"):
        failures.append("examId was not preserved")
    if document.get("reviewRevision") != case["request"].get("reviewRevision"):
        failures.append("reviewRevision was not preserved")
    trace = document.get("trace")
    nodes = trace.get("nodes", []) if isinstance(trace, dict) else []
    required_nodes = expect.get("requiredNodes", [])
    if not isinstance(nodes, list) or any(node not in nodes for node in required_nodes):
        failures.append("required graph nodes were not observed")

    if case["endpoint"] == "/v1/tutor":
        if document.get("schemaVersion") not in {"cet-agent-tutor/1", "cet-agent-tutor/2"}:
            failures.append("unexpected tutor schemaVersion")
        if document.get("questionId") != case["request"].get("questionId"):
            failures.append("questionId was not preserved")
        if "intent" in expect and document.get("intent") != expect["intent"]:
            failures.append(f"intent expected {expect['intent']!r}")
        grounding = document.get("grounding") if isinstance(document.get("grounding"), dict) else {}
        if "groundingStatus" in expect and grounding.get("status") != expect["groundingStatus"]:
            failures.append(f"grounding status expected {expect['groundingStatus']!r}")
        if "disclaimerRequired" in expect and grounding.get("disclaimerRequired") is not expect["disclaimerRequired"]:
            failures.append("disclaimerRequired did not match")
        citations = document.get("citations", [])
        if not isinstance(citations, list) or len(citations) < int(expect.get("minimumCitations", 0)):
            failures.append("citation count is below the minimum")
        tools = document.get("tools", [])
        tool_names = {
            item.get("name") for item in tools if isinstance(item, dict) and item.get("status") == "completed"
        } if isinstance(tools, list) else set()
        if any(name not in tool_names for name in expect.get("requiredTools", [])):
            failures.append("required tools were not completed")
        reply = document.get("reply") if isinstance(document.get("reply"), str) else ""
        if "replyContains" in expect and not _contains_all(reply, expect["replyContains"]):
            failures.append("reply is missing required safety text")
    else:
        if document.get("schemaVersion") != "cet-agent-review-suggestion/1":
            failures.append("unexpected review schemaVersion")
        if document.get("policy") != "suggest_only":
            failures.append("review policy is not suggest_only")
        proposals = document.get("proposals", [])
        if not isinstance(proposals, list) or len(proposals) != expect.get("proposalCount"):
            failures.append("proposal count did not match")
        else:
            actual_fields = {
                f"{item.get('entity')}.{item.get('field')}" for item in proposals if isinstance(item, dict)
            }
            if actual_fields != set(expect.get("proposalFields", [])):
                failures.append("proposal fields did not match the allow-listed expectation")
            if any(isinstance(item, dict) and item.get("op") != "replace" for item in proposals):
                failures.append("review returned a non-replace proposal")
        if "rationaleContains" in expect:
            rationale = document.get("rationale") if isinstance(document.get("rationale"), str) else ""
            if not _contains_all(rationale, expect["rationaleContains"]):
                failures.append("rationale is missing required safety text")
    return failures


def request_case(origin: str, token: str, timeout: float, case: dict[str, Any]) -> tuple[dict[str, Any], int]:
    payload = json.dumps(case["request"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(origin + case["endpoint"], data=payload, headers=headers, method="POST")
    started = time.monotonic()
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            media_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    except HTTPError as error:
        raise EvalError(f"HTTP {error.code}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise EvalError("Agent runtime is unavailable") from error
    duration_ms = max(0, int(round((time.monotonic() - started) * 1000)))
    if media_type != "application/json" or len(raw) > MAX_RESPONSE_BYTES:
        raise EvalError("Agent returned an invalid or oversized response")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise EvalError("Agent returned invalid JSON") from error
    if not isinstance(document, dict):
        raise EvalError("Agent response is not an object")
    return document, duration_ms


def percentile(values: list[int], quantile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the CET Agent golden contract evals")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--endpoint", default=os.environ.get("CET_AGENT_URL", "http://127.0.0.1:8770"))
    parser.add_argument("--token", default=os.environ.get("CET_AGENT_TOKEN", ""))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()
    try:
        cases = load_cases(args.cases)
        if args.validate_only:
            print(f"Validated {len(cases)} Agent eval cases from {args.cases}")
            return 0
        if not math.isfinite(args.timeout) or not 0.2 <= args.timeout <= 120:
            raise EvalError("--timeout must be between 0.2 and 120 seconds")
        origin = _origin(args.endpoint)
        results: list[dict[str, Any]] = []
        durations: list[int] = []
        for case in cases:
            try:
                document, duration_ms = request_case(origin, args.token, args.timeout, case)
                failures = evaluate_response(case, document)
            except EvalError as error:
                duration_ms = 0
                failures = [str(error)]
            durations.append(duration_ms)
            results.append({
                "caseId": case["caseId"],
                "passed": not failures,
                "durationMs": duration_ms,
                "failures": failures,
            })
        passed = sum(1 for item in results if item["passed"])
        report = {
            "schemaVersion": "cet-agent-eval-report/1",
            "total": len(results),
            "passed": passed,
            "failed": len(results) - passed,
            "passRate": round(passed / len(results), 4),
            "latencyMs": {
                "mean": round(statistics.fmean(durations), 2),
                "p50": percentile(durations, 0.5),
                "p95": percentile(durations, 0.95),
            },
            "results": results,
        }
        if args.json_output:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            for item in results:
                marker = "PASS" if item["passed"] else "FAIL"
                detail = "" if item["passed"] else " — " + "; ".join(item["failures"])
                print(f"[{marker}] {item['caseId']} ({item['durationMs']} ms){detail}")
            print(
                f"Passed {passed}/{len(results)} · "
                f"P50 {report['latencyMs']['p50']} ms · P95 {report['latencyMs']['p95']} ms"
            )
        return 0 if passed == len(results) else 1
    except EvalError as error:
        print(f"Agent eval error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
