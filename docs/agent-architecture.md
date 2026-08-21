# CET Agent 架构、运行与安全边界

本文描述可选的 `services/agent` LangGraph sidecar。它是在现有 PDF/OCR、复核版本和阅读器之上增加的受限 Agent 运行层，不替换原有解析 Pipeline，也不把确定性批改交给大模型。

## 1. 当前定位

项目现在同时包含两类能力：

- 确定性平台能力：文件校验、PDF/OCR、坐标、题目与答案版本、RAG 检索、客观题批改和 ETag 发布；
- Agent 能力：按意图选择只读上下文工具、按题号优先组织证据、生成带引用的辅导回答，以及为复核问题生成只读字段建议。

因此它属于“带 Agent 工作流的智能文档应用”，而不是允许模型任意访问系统的通用自治 Agent。这个边界是有意保留的：OCR、答案绑定、批改和版本发布必须继续可复现、可校验。

## 2. 部署拓扑

```text
Browser
  ├── reader.html  ── 按题问答、引用与运行轨迹
  └── review.html  ── 建议预览、人工应用到表单
          │
          ▼
Python 3.8 main server :4173
  ├── PDF/OCR/manifest/questions/answers
  ├── revision + ETag + audit snapshot
  ├── Question ID exact retrieval + local vector supplement
  └── bounded Agent adapter
          │ revision-pinned JSON + optional Bearer token
          ▼
Python 3.11 Agent runtime :8770
  ├── LangGraph state graphs
  ├── SQLite checkpoints
  ├── context-only tools
  └── optional DeepSeek grounded drafting
```

主服务保持 Python 3.8 和零第三方运行依赖；LangGraph 及其 SQLite checkpointer 只安装在 Python 3.11 sidecar。未启动或未配置 sidecar 时，上传、解析、阅读、人工复核、批改以及原来的保守问答仍可使用。

## 3. 两条 Agent 工作流

### Tutor graph

```text
route_intent
  → read_context_tools
  → retrieve_grounded_evidence
  → draft_grounded_reply
  → grounding_guard
  → finalize_tutor
```

- `route_intent` 区分选项解释、答案解析、证据定位、语言帮助和不允许的修改请求；
- 上下文工具只能读取主服务已经锁定到同一 `reviewRevision` 的题目、答案和证据；
- 检索顺序固定为 Question ID 精确结果优先、确定性向量结果补充；
- `grounding_guard` 补齐“没有官方解析”的声明，并拒绝把资料不足伪装成官方结论；
- Reader 保留旧的 `reply` 字段，同时按需展示 `citations`、工具状态、节点轨迹、Run ID 和耗时。

### Review suggestion graph

```text
load_review_issue
  → retrieve_review_evidence
  → build_suggest_only_proposal
  → suggestion_policy_guard
  → finalize_review_suggestion
```

输出策略固定为 `suggest_only`。Agent 返回的是字段级 `proposals`，不是复核 PATCH，也没有写文件、写数据库或发布 revision 的工具。

允许建议的字段只有：

| 实体 | 字段 |
| --- | --- |
| `question` | `stem`、`type`、`page`、`bbox`、`options` |
| `answer` | `answer`、`explanation` |

`questionId` 和题号不会由 Agent 改写。Review 页面再次校验 schema、当前题号、revision、坐标、选项与答案关系；用户必须点击“应用到表单（不会保存）”，核对原卷并填写修改理由，最后才可通过原有 ETag PATCH 发布新版本。证据不足时 `proposals` 可以为空，页面会展示原因，不要求 Agent 猜测。

这是应用层 Human-in-the-loop：Agent 负责建议，既有复核工作台负责人工批准和确定性写入。当前没有把浏览器等待状态伪装成一个长期挂起的模型调用。

## 4. 启动 Agent runtime

创建独立环境：

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/pip install -r services/agent/requirements.txt
```

生成一段只供本机服务间使用的随机 Token，并分别提供给 sidecar 和主服务。sidecar 不会自动读取项目 `.env`，本地启动时显式传入：

```bash
CET_AGENT_TOKEN='替换为随机Token' \
CET_AGENT_CHECKPOINT_PATH="$PWD/data/agent/checkpoints.sqlite3" \
DEEPSEEK_API_KEY='替换为DeepSeek密钥' \
.venv-agent/bin/python -m services.agent.app --host 127.0.0.1 --port 8770
```

`DEEPSEEK_API_KEY` 是可选项。没有密钥时 Agent 仍能运行确定性路由、检索、引用、保守回答和复核建议，不会调用外部模型。

在项目根目录 `.env` 中配置主服务适配器：

```dotenv
CET_AGENT_URL=http://127.0.0.1:8770
CET_AGENT_TOKEN=与sidecar相同的Token
CET_AGENT_TIMEOUT_SECONDS=40
```

再启动主服务：

```bash
python3 -m server
```

可检查 sidecar 自身健康状态：

```bash
curl -H 'Authorization: Bearer 替换为随机Token' http://127.0.0.1:8770/healthz
```

也可访问主服务的 `GET /api/exams/capabilities`，查看 `agent.configured`、`reachable`、`ready`、LangGraph、checkpoint 和 DeepSeek 状态。健康检查不会泄露 Token、密钥或 checkpoint 路径。

## 5. 浏览器公开契约

### 获取复核建议

```http
POST /api/exams/{examId}/agent/review-suggestions
Content-Type: application/json

{"issueId":"...","reviewRevision":3}
```

核心响应：

```json
{
  "schemaVersion": "cet-agent-review-suggestion/1",
  "policy": "suggest_only",
  "reviewRevision": 3,
  "issueId": "...",
  "proposals": [
    {
      "op": "replace",
      "entity": "answer",
      "questionId": "q26",
      "field": "answer",
      "value": "C",
      "confidence": 0.95,
      "evidenceSources": ["answer_pdf"]
    }
  ],
  "rationale": "...",
  "evidence": [],
  "cautions": [],
  "trace": {"nodes": ["load_review_issue"], "durationMs": 18}
}
```

主服务在调用 sidecar 之前已经解析 `issueId` 并锁定当前快照；revision 变化返回 `409`，问题不存在返回 `404`，sidecar 未配置或不可用返回 `503`，sidecar 协议无效返回 `502`。这些错误都不会降级成自动修改。

### 按题辅导的增量字段

既有 `POST /api/exams/{examId}/assistant` 请求和 `reply` 响应保持兼容。成功走 Agent 时额外返回：

```json
{
  "citations": [
    {"source": "answer_pdf", "questionId": "q26", "page": 2, "excerpt": "..."}
  ],
  "agent": {
    "runId": "...",
    "intent": "option_explanation",
    "tools": [{"name": "retrieve_evidence", "status": "completed"}],
    "trace": {"nodes": ["route_intent", "retrieve_grounded_evidence"], "durationMs": 24}
  }
}
```

旧服务只返回回答正文时，Reader 继续按旧方式显示；新字段存在时才出现可折叠的“资料依据”和“Agent 运行”。所有外部字符串都通过 `textContent` 写入 DOM，不解释为 HTML，也不把服务端提供的任意 URL 变成可点击链接。

## 6. 安全与失败策略

- sidecar 工具只读取请求中的受限 context；没有 Shell、浏览器、任意 HTTP、文件系统或数据库写入工具；
- 主服务不把本机路径、API Key 或复核写权限交给 Agent；
- 浏览器只能访问主服务公开路由，不能替 Agent 构造任意内部 context；
- 请求、响应、历史、证据和模型输出都有数量与长度上限，并采用严格 JSON schema；
- `examId + questionId + reviewRevision` 共同限定辅导上下文，复核建议还绑定 `issueId`；
- sidecar 使用 Bearer Token 做服务间认证，默认只监听 `127.0.0.1`；
- DeepSeek 失败、模型输出无效或 sidecar 不可用时，主服务回退到既有保守路径；
- sidecar 模型超时默认 25 秒，主服务 Agent transport 超时默认 40 秒，使慢模型优先在 sidecar 内完成保守降级，减少重复上游请求；
- 不向界面暴露隐藏推理过程，只展示节点名、工具状态、引用、Run ID 和耗时；
- checkpoint 用于运行状态与故障审计，不代替不可变 review revision，也不授权自动发布。
- checkpoint 默认只保留最近 50 个运行线程（含失败运行），可用 `CET_AGENT_CHECKPOINT_MAX_THREADS` 在 1–10000 范围调整，避免每次新 Run 导致 SQLite 无界增长。

当前仍是本地单用户系统。若通过反向代理暴露公网，必须先增加用户鉴权、租户隔离、CSRF/Origin 策略、限流、日志脱敏和密钥管理；仅依靠 loopback 与共享 Token 不构成公网安全方案。

## 7. 验证与后续工程化

基础回归：

```bash
node --check public/js/review.js
node --check public/js/reader.js
python3 -m py_compile server/agent_client.py services/agent/app.py
python3 -m unittest discover -s tests -v
python3 tools/run_agent_evals.py --validate-only
```

`evals/agent_cases.jsonl` 已提供不含真题版权内容的固定黄金案例。启动 sidecar 后执行
`python3 tools/run_agent_evals.py`，可得到意图路由、工具、grounding、只读策略的通过率及 P50/P95 延迟；`--json` 适合接入 CI。

下一阶段适合补充的求职展示能力：

1. 用 OpenTelemetry/OpenInference 接入 Phoenix，保留当前前端简洁 trace 作为用户可见审计摘要；
2. 把题目、答案和检索封装成只读 MCP Server，写工具继续要求真实身份与人工批准；
3. 将本地哈希向量升级为 BM25 + 语义 Embedding + reranker，并用 Recall@k/MRR 量化，而不是只替换数据库名称；
4. 把现有黄金案例扩充到人工复核生成的数据集，并加入 prompt/model/retriever 版本对比与 CI 阈值；
5. 在确有跨进程等待需求时，为复核图增加 LangGraph `interrupt/resume` API，而不是让模型请求长期占用浏览器连接。

面试演示应重点展示一次完整闭环：发现低置信问题 → Agent 读取受限证据 → 返回字段级建议 → 人工应用但尚未保存 → ETag 发布新 revision → Reader 在新 revision 下给出带引用回答。这个流程比增加多个互相聊天的 Agent 更能说明工程可靠性。
