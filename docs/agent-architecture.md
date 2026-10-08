# CET Agent v1：运行、工具、记忆与安全边界

本轮保留原生阅读器和确定性的 PDF/OCR、答案绑定、批改及复核发布。Agent 是题目辅导的受限运行层，不是能任意访问电脑、自动改答案的通用助手。

## 1. 实际执行路径

| 模式 | 路径 | 服务端会话记忆 |
| --- | --- | --- |
| question | 已配置且 ready 时走 LangGraph；未配置可主服务直连 DeepSeek | LangGraph 路径可用 |
| general | 主服务直连 DeepSeek，不读试卷答案 PDF | 无，使用受限客户端历史 |
| selection | 主服务直连 DeepSeek，可附带授权学习证据 | 无，使用受限客户端历史 |
| 复核建议 | 独立确定性 LangGraph 图，suggest_only | 无辅导会话 |

已配置 Agent 但请求失败时只给安全失败／资料提示，不隐式再发另一条付费模型请求。健康检查与配置存在不等于 Key、余额或真实教学效果已经验证。面板及 `/api/exams/capabilities` 显示实际 readiness。

## 2. 部署与启动

```text
Browser reader / translation / review
              │ same-origin JSON / SSE
Python 3.11 main :4173
  ├─ immutable exam revision + exact answer binding
  ├─ BM25 / hash lexical + optional local dense / RRF
  └─ validated bounded Agent context
              │ local HTTP + Bearer token
Python 3.11 LangGraph :8770
  ├─ bounded model / context-tools loop
  ├─ source guard + suggest-only review
  └─ SQLite Run checkpoints + bounded conversation memory
```

主服务只依赖标准库。LangGraph 安装到独立 `.venv-agent`，两者都是 Python 3.11：

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r services/agent/requirements.txt
bash tools/start.sh
```

`tools/start_platform.py` 读取主服务已有环境／项目 `.env`，检查本机 8770。依赖可用则先启动 Agent，再启动原主服务；没有 Token 时为两个自建子进程共享本次随机 Token。它不改 `.env`、不安装依赖、不下载模型、不调用 LLM。只复用同 Token 的 ready Agent；其它进程占用端口时不接管。Ctrl+C 只清理本次创建的子进程。

`CET_MANAGED_AGENT=0 bash tools/start.sh` 关闭联动；显式 `CET_AGENT_URL` 保留操作者配置。`.venv-main/bin/python -m server` 仍只启动主服务。手动 sidecar 不自动读取 `.env`，需显式提供相同 Token、模型环境和 checkpoint 路径，见 [runtime 文档](../services/agent/README.md)。

## 3. 有界工具决策

模型可用、请求不是禁止修改时，Tutor 图运行“意图路由 → 模型决策 → 白名单工具 → 再决策／回答 → 来源守卫 → 完成”。无模型时继续确定性的 context／retrieval／保守回答流程，无 Key 不访问模型网络。

六种工具在 `services/agent/runtime_tools.py`：

- `get_current_question`：读取服务器批准的当前题；
- `get_answer_record`：读取绑定当前题的上传／复核答案；
- `retrieve_evidence`：在本次有限证据包中补查；
- `retrieve_methods`：检索公开方法及本次明确授权的个人方法片段；
- `retrieve_personal_notes`：只读取本次明确授权的个人资料；
- `compare_options`：读取题目中存在的选项，不改写／计算正确答案。

模型可以改变调用顺序、补查或询问用户。工具不能 Shell、任意 HTTP、浏览器自动化、遍历文件、写库或发布复核；不能索取另一份试卷。补查是在主服务已检索、固定版本的有限 context 内完成，不是无限制重新扫描全库。

预算最多 4 轮决策、12 次工具调用、30 秒及约 8,000 token。输入估算与上游报告参与保护，单次输出也有限制；这不是账单硬上限。非法参数、重复 call ID、超时、预算和取消均会停止。`execution` 返回实际模式、轮数、调用次数与停止原因。usage 缺报是未知，不是免费。

## 4. 检索和来源

Question ID 精确证据永远优先，另一题只能提供背景，不能建立当前题的正确答案。方法 ID 精确检索同样优先，公开源文使用 SHA-256 revision。

`server/retrieval.py` 默认 BM25＋哈希词项（`lexical_hash`）。明确配置、启动本地模型后，融合 dense 排名（RRF），可选本地 CrossEncoder；当前未预装或自动下载语义权重，不把哈希冒充 Embedding。模型服务只接受数值 loopback HTTP，拒绝公网、代理、跳转和客户端模型路径，见 [Embedding 文档](../services/embeddings/README.md)。

缓存绑定试卷／方法版本、模型内容指纹、维度及正文，存向量／哈希不存正文；每次最多生成 128 个新 chunk 向量，大资料首次不足显示 `hybrid_semantic_partial`。服务失败明确词项回退，损坏缓存不覆盖。授权笔记 `persist=False`，只在当前请求排序，不写个人语义索引。

学习来源的 `learningCitations / learningGrounding` 与官方答案 grounding 分离。没有官方解析必须声明“答案资料中没有找到官方解析，以下为 AI 辅助分析”。守卫和来源检查不构成生成内容语义正确的证明。

## 5. 会话与授权撤销

稳定 `conversationId` 与每次新 `runId` 分离；每次使用独立 Run checkpoint，避免恢复旧图重新引入撤销的证据。memory key 绑定试卷、题号、会话；范围指纹绑定 revision、当前题／答案、授权状态和私人正文。真实版本／私人内容变化清除旧范围及关联运行记录；公开排名或当前用户答案变化本身不应丢失正常会话。

SQLite 最多保留最近 6 轮，每条最多 2,000 字符；旧轮提取片段为 1,200 字符摘要，不额外调用模型，不当官方事实。持久会话忽略客户端 history，避免重新注入撤销资料。默认最多保留 50 个会话和 50 个近期 Run，`CET_AGENT_CHECKPOINT_MAX_THREADS` 可调整 1–10000。

新建对话／撤销个人授权明确请求删除旧会话及关联 checkpoint。无法确认删除时保留待删除标记，刷新后继续处理，并阻止继续携带旧私人上下文，不能只换 ID 就宣称已删除。清除还须阻止排队／正在生成的旧调用迟到后重新保存。

这是本机单用户隐私保护，不是 Users、租户隔离、云同步或长期用户画像；同一浏览器／服务器的数据仍共享。清除不删除磁盘或外部备份副本。

## 6. SSE 与公开接口

`POST /api/exams/{id}/assistant/stream` 为同一助手调用输出安全节点／工具进度、心跳和终态结果。有界并发／队列和写超时，不暴露密钥、完整资料或思维链。最终 Markdown 仍整段返回，不是 DeepSeek token 流。

停止按钮 abort 连接，主服务／sidecar 协作停止后续节点和保存。已执行的外部模型请求无法撤回、可能计费，不能保证退款；前端收到完整 result 才写最终历史。只有明确不支持 stream 路由才改用兼容 JSON，已经开始的模型请求失败不自动重发。

| 接口 | 用途 |
| --- | --- |
| `/api/exams/capabilities` | Agent／记忆／SSE／检索 readiness，不调用模型 |
| `/api/exams/{id}/assistant` | 原三 scope 助手 |
| `/api/exams/{id}/assistant/stream` | 真实进度、最终回复与协作取消 |
| `/api/exams/{id}/assistant/conversations/clear` | 本机、same-origin、已验证题号的明确记忆清除 |
| `/api/exams/{id}/agent/review-suggestions` | 当前 issue/revision 的只读建议 |

复核图仍是 suggest_only，只允许 question 的 stem/type/page/bbox/options 和 answer 的 answer/explanation；不改题号／ID、不调用模型、不能自动 PATCH。用户应用到表单、核查、填理由，由既有 ETag 流程发布。这是应用层 Human-in-the-loop，尚无 LangGraph interrupt/resume 跨进程审批 API。

## 7. 验证及下一阶段

```bash
env DEEPSEEK_API_KEY= CET_AGENT_URL= CET_EMBEDDING_URL= .venv-agent/bin/python -m unittest discover -s tests -v
.venv-agent/bin/python tools/run_agent_evals.py --validate-only
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --offline --min-pass-rate 1 --json
npm run test:browser
```

保留原 5 条案例，新增 60 条合成 v1 案例：路由、资料绑定、只读、授权、来源原文匹配与答案标记。来源匹配不等于语义蕴含，答案标记不等于教学质量；离线模式不代表真实 DeepSeek 的质量／成本或本地模型 Recall，见 [评测说明](../evals/README.md)。动态决策及语义 paraphrase 另用 mock 模型单测覆盖。

后续应补人工标注 Recall@k/MRR、真实模型结论支持度／提示质量，以及经授权的 latency/cost 测量。公网部署前先补身份、租户／试卷授权、CSRF、配额、脱敏及密钥管理；loopback 和共享 Token 不是公网鉴权。MCP、多 Agent、监控平台、可恢复审批按需求增加，暂不作为已完成技术。
