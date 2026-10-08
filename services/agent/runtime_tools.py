"""Pure context-only tool implementations. No network/filesystem/write tools."""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

TOOL_NAMES = frozenset({"get_current_question", "get_answer_record", "retrieve_evidence", "retrieve_methods", "retrieve_personal_notes", "compare_options"})
DESCRIPTIONS = {
    "get_current_question": "读取已绑定的当前题目、题干和选项。不能指定其他题目。",
    "get_answer_record": "读取上传答案资料中当前题的答案及解析。没有资料就返回未找到。",
    "retrieve_evidence": "按当前题号优先检索服务器已批准的答案资料片段，关键词补充。",
    "retrieve_methods": "检索本次已批准的公开学习方法及已授权的个人方法。",
    "retrieve_personal_notes": "只检索本次用户明确授权且由主服务提供的个人笔记。",
    "compare_options": "并列读取当前题目中两个已有选项；只比较资料，不猜测答案。",
}


def definitions() -> list[dict[str, Any]]:
    result = []
    for name in sorted(TOOL_NAMES):
        properties: dict[str, Any] = {}
        required = []
        if name.startswith("retrieve_"):
            properties = {"query": {"type": "string", "maxLength": 1000}, "limit": {"type": "integer", "minimum": 1, "maximum": 8}}
        elif name == "compare_options":
            properties = {"left": {"type": "string", "pattern": "^[A-O]$"}, "right": {"type": "string", "pattern": "^[A-O]$"}}
            required = ["left", "right"]
        result.append({"type": "function", "function": {"name": name, "description": DESCRIPTIONS[name], "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}})
    return result


def validate_call(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"id", "type", "function"} or raw["type"] != "function":
        raise ValueError("invalid tool call")
    if not isinstance(raw["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", raw["id"]):
        raise ValueError("invalid tool call id")
    function = raw["function"]
    if not isinstance(function, dict) or set(function) != {"name", "arguments"} or not isinstance(function["name"], str) or function["name"] not in TOOL_NAMES:
        raise ValueError("tool is not allowlisted")
    encoded = function["arguments"]
    if not isinstance(encoded, str) or len(encoded) > 2000:
        raise ValueError("invalid tool arguments")
    try:
        arguments = json.loads(encoded)
    except (ValueError, RecursionError):
        raise ValueError("invalid tool arguments") from None
    if not isinstance(arguments, dict):
        raise ValueError("invalid tool arguments")
    name = function["name"]
    if name.startswith("retrieve_"):
        if set(arguments) - {"query", "limit"}:
            raise ValueError("unknown tool arguments")
        if not isinstance(arguments.get("query", ""), str) or len(arguments.get("query", "")) > 1000:
            raise ValueError("invalid tool query")
        limit = arguments.get("limit", 4)
        if type(limit) is not int or not 1 <= limit <= 8:
            raise ValueError("invalid tool limit")
    elif name == "compare_options":
        if set(arguments) != {"left", "right"} or any(not isinstance(arguments[item], str) or not re.fullmatch(r"[A-O]", arguments[item]) for item in arguments):
            raise ValueError("invalid option labels")
    elif arguments:
        raise ValueError("tool accepts no arguments")
    return {"id": raw["id"], "name": name, "arguments": arguments, "wire": raw}


def execute(call: Mapping[str, Any], request: Mapping[str, Any], rank_evidence: Any, flatten_evidence: Any) -> dict[str, Any]:
    context = request["context"]
    name = call["name"]
    arguments = call["arguments"]
    hint = context.get("learningContext", {}).get("mode") == "hint"
    if name == "get_current_question":
        value = context.get("question")
    elif name == "get_answer_record":
        # A next-step hint never grants the model a complete reference answer.
        value = None if hint else context.get("officialAnswer")
    elif name == "compare_options":
        options = {item.get("label"): item for item in context.get("question", {}).get("options", [])}
        value = [options[label] for label in (arguments["left"], arguments["right"]) if label in options]
        if len(value) != 2:
            value = []
    elif name == "retrieve_evidence":
        value = [] if hint else rank_evidence(flatten_evidence(context), request["questionId"], arguments.get("query") or request["message"], arguments.get("limit", 4))
    else:
        authorized = context.get("learningContext", {}).get("consentPersonal", False)
        if name == "retrieve_personal_notes":
            kinds = {"personal_note"} if authorized else set()
        else:
            kinds = {"learning_method", "personal_method"} if authorized else {"learning_method"}
        value = [item for item in context.get("learningEvidence", []) if item["kind"] in kinds]
        query = set(re.findall(r"[a-z0-9]+|[\u3400-\u9fff]", (arguments.get("query") or request["message"]).lower()))
        value.sort(key=lambda item: (item.get("exact", False), len(query & set(re.findall(r"[a-z0-9]+|[\u3400-\u9fff]", (item["title"] + item["text"]).lower())))), reverse=True)
        value = value[:arguments.get("limit", 4)]
    # Truncate individual long texts explicitly rather than cut JSON mid-byte.
    def bounded(raw: Any, maximum: int = 1800) -> Any:
        if isinstance(raw, str):
            return raw if len(raw) <= maximum else raw[:maximum] + "\n[资料片段已截断]"
        if isinstance(raw, dict):
            return {key: bounded(item, maximum) for key, item in list(raw.items())[:40]}
        if isinstance(raw, list):
            return [bounded(item, maximum) for item in raw[:8]]
        return raw
    clipped = bounded(value)
    # Tool messages are globally bounded as well as individual fields.
    if isinstance(clipped, list):
        while clipped and len(json.dumps(clipped, ensure_ascii=False)) > 6500:
            clipped.pop()
    elif len(json.dumps(clipped, ensure_ascii=False)) > 6500:
        clipped = bounded(value, 500)
        if isinstance(clipped, dict) and len(json.dumps(clipped, ensure_ascii=False)) > 6500:
            # Existing platform records allow arbitrary parser metadata. Only
            # the useful allowlisted fields go back to the model when large.
            fields = {"questionId", "number", "type", "stem", "options", "passage", "answer", "explanation", "source", "page"}
            clipped = {key: item for key, item in clipped.items() if key in fields}
            if len(json.dumps(clipped, ensure_ascii=False)) > 6500:
                clipped = {"questionId": request["questionId"], "stem": str(value.get("stem") or "")[:4000], "truncated": True}
    return {"tool": name, "questionId": request["questionId"], "found": bool(clipped), "data": clipped}
