"""Bounded, scope-pinned local conversation memory (not a user database).

Only server-approved tutor turns enter this table.  Graph checkpoints use a
fresh run ID: resuming an old checkpoint would otherwise restore revoked
personal evidence.  Changing revision/consent/evidence deletes the old memory
and its audit checkpoints before loading any history.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from typing import Any, Callable, Mapping

MAX_TURNS = 6
MAX_TURN_CHARS = 2000
MAX_SUMMARY_CHARS = 1200
TOMBSTONE_TTL_NS = 120 * 1_000_000_000  # > the 30-second maximum invocation.
MAX_CLEAR_TOMBSTONES = 4096


def identity(request: Mapping[str, Any]) -> tuple[str, str]:
    owner = json.dumps([request["examId"], request["questionId"], request["conversationId"]], separators=(",", ":"))
    context = request["context"]
    study = context.get("learningContext", {})
    private = [{key: item.get(key) for key in ("id", "kind", "title", "text")} for item in context.get("learningEvidence", []) if item.get("kind") in {"personal_note", "personal_method"}]
    private.sort(key=lambda item: (item["kind"], item["id"], item["text"]))
    # Ignore query-dependent rankings and public snippets so an ordinary next
    # question can reuse memory. Pin authoritative question/answer content,
    # revision, consent and every approved private byte (not just note IDs).
    scope = json.dumps([request["reviewRevision"], context.get("question"), context.get("officialAnswer"),
                        bool(study.get("consentPersonal", False)), private], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(owner.encode()).hexdigest(), hashlib.sha256(scope.encode()).hexdigest()


class ConversationMemory:
    def __init__(self, connection: sqlite3.Connection, delete_checkpoint: Callable[[str], None], maximum: int = 50):
        self.connection = connection
        self.delete_checkpoint = delete_checkpoint
        self.maximum = maximum
        connection.execute("CREATE TABLE IF NOT EXISTS cet_agent_memory (owner TEXT PRIMARY KEY, scope TEXT NOT NULL, summary TEXT NOT NULL, turns TEXT NOT NULL, updated_ns INTEGER NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS cet_agent_memory_runs (owner TEXT NOT NULL, run_id TEXT PRIMARY KEY)")
        connection.execute("CREATE TABLE IF NOT EXISTS cet_agent_memory_clears (owner TEXT PRIMARY KEY, cleared_ns INTEGER NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS cet_agent_memory_clear_floor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cleared_ns INTEGER NOT NULL)")
        connection.commit()

    def clear(self, owner: str) -> bool:
        """Explicit user deletion invalidates requests already waiting in line.

        A scope reset/retention prune calls clear_owner, not this operation: it
        must not cancel a legitimate fresh invocation of the changed scope.
        """
        now = time.time_ns()
        self.connection.execute("DELETE FROM cet_agent_memory_clears WHERE cleared_ns<?", (now - TOMBSTONE_TTL_NS,))
        self.connection.execute("INSERT OR REPLACE INTO cet_agent_memory_clears(owner,cleared_ns) VALUES(?,?)", (owner, now))
        overflow = self.connection.execute("SELECT owner,cleared_ns FROM cet_agent_memory_clears ORDER BY cleared_ns DESC LIMIT -1 OFFSET ?", (MAX_CLEAR_TOMBSTONES,)).fetchall()
        if overflow:
            # Never discard a still-live cancellation marker silently. Under
            # an extreme clear burst a single global watermark fails closed
            # for older queued requests rather than resurrect deleted data.
            watermark = max(row[1] for row in overflow)
            self.connection.execute("INSERT INTO cet_agent_memory_clear_floor(singleton,cleared_ns) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET cleared_ns=MAX(cleared_ns,excluded.cleared_ns)", (watermark,))
            self.connection.executemany("DELETE FROM cet_agent_memory_clears WHERE owner=?", [(row[0],) for row in overflow])
        self.connection.commit()
        return self.clear_owner(owner)

    def cleared_after(self, owner: str, started_ns: int) -> bool:
        floor = self.connection.execute("SELECT cleared_ns FROM cet_agent_memory_clear_floor WHERE singleton=1").fetchone()
        row = self.connection.execute("SELECT cleared_ns FROM cet_agent_memory_clears WHERE owner=?", (owner,)).fetchone()
        return bool((floor is not None and started_ns <= floor[0]) or (row is not None and started_ns <= row[0]))

    def clear_owner(self, owner: str) -> bool:
        existed = self.connection.execute("SELECT 1 FROM cet_agent_memory WHERE owner=?", (owner,)).fetchone() is not None
        rows = self.connection.execute("SELECT run_id FROM cet_agent_memory_runs WHERE owner=?", (owner,)).fetchall()
        for row in rows:
            self.delete_checkpoint(str(row[0]))
            self.connection.execute("DELETE FROM cet_agent_threads WHERE thread_id=?", (row[0],))
        self.connection.execute("DELETE FROM cet_agent_memory_runs WHERE owner=?", (owner,))
        self.connection.execute("DELETE FROM cet_agent_memory WHERE owner=?", (owner,))
        self.connection.commit()
        return existed or bool(rows)

    def load(self, owner: str, scope: str) -> tuple[str, list[dict[str, str]], bool]:
        row = self.connection.execute("SELECT scope,summary,turns FROM cet_agent_memory WHERE owner=?", (owner,)).fetchone()
        reset = row is not None and row[0] != scope
        if reset:
            self.clear_owner(owner)
            return "", [], True
        if row is None:
            # A failed/cancelled run may have checkpoints but no saved turns.
            # Without a trustworthy saved scope, discard those raw states
            # before accepting fresh context (including revoked consent).
            orphan_runs = self.connection.execute("SELECT 1 FROM cet_agent_memory_runs WHERE owner=? LIMIT 1", (owner,)).fetchone()
            if orphan_runs is not None:
                self.clear_owner(owner)
            return "", [], orphan_runs is not None
        try:
            turns = json.loads(row[2])
            if not isinstance(turns, list) or len(turns) > MAX_TURNS * 2 or any(
                not isinstance(item, dict) or set(item) != {"role", "content"}
                or item["role"] not in {"user", "assistant"}
                or not isinstance(item["content"], str) or len(item["content"]) > MAX_TURN_CHARS for item in turns
            ) or not isinstance(row[1], str) or len(row[1]) > MAX_SUMMARY_CHARS:
                raise ValueError("invalid memory")
        except (ValueError, TypeError, RecursionError):
            self.clear_owner(owner)
            return "", [], True
        return row[1], turns, False

    def save(self, owner: str, scope: str, summary: str, history: list[dict[str, str]], message: str, reply: str, run_id: str) -> tuple[int, bool]:
        turns = history + [{"role": "user", "content": message[:MAX_TURN_CHARS]}, {"role": "assistant", "content": reply[:MAX_TURN_CHARS]}]
        removed = turns[:-MAX_TURNS * 2]
        if removed:
            # Explicitly extractive, never presented as facts or official
            # analysis. No extra hidden model request / token cost.
            snippets = "\n".join(f"{item['role']}: {item['content'][:200]}" for item in removed)
            summary = (summary + "\n" + snippets).strip()[-MAX_SUMMARY_CHARS:]
        turns = turns[-MAX_TURNS * 2:]
        self.connection.execute("INSERT OR REPLACE INTO cet_agent_memory(owner,scope,summary,turns,updated_ns) VALUES(?,?,?,?,?)", (owner, scope, summary, json.dumps(turns, ensure_ascii=False), time.time_ns()))
        self.connection.execute("INSERT OR REPLACE INTO cet_agent_memory_runs(owner,run_id) VALUES(?,?)", (owner, run_id))
        stale = self.connection.execute("SELECT owner FROM cet_agent_memory ORDER BY updated_ns DESC LIMIT -1 OFFSET ?", (self.maximum,)).fetchall()
        for row in stale:
            self.clear_owner(str(row[0]))
        self.connection.commit()
        return len(turns) // 2, bool(summary)
