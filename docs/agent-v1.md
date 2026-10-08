# Agent v1：本轮升级和演示路径

这是现有 CET 平台的一版增量 Agent 升级，保留 PDF 图片、透明文字、SVG 标注和题目交互层；不重写前端，不增加登录，也不允许模型自动改试卷答案。

## 已完成

1. 联动启动：`bash tools/start.sh` 检查已安装的 `.venv-agent`，可用时管理 Agent 和原主服务，共享本次 Token；不写 `.env`、不装包、不下载模型、不请求 LLM。
2. 动态工具：题目模式由模型在六种只读 context 工具之间决策，最多 4 轮／12 次调用／30 秒；约 8,000 token 估算和 usage 保护不是账单保证。
3. 检索基线：题号／方法 ID 精确优先，BM25／哈希词项＋可选本地 dense、RRF 和重排序，按试卷、资料版本与模型指纹缓存。
4. 有限记忆：稳定 conversation ID 独立于每次 Run checkpoint；最近 6 轮和提取式 1,200 字符摘要，版本／授权私人正文变化清除旧范围。明确清除包括关联运行状态、排队旧调用保护和前端待删除标记。
5. 可见运行：Reader 和翻译页显示实际 Agent 状态、节点／工具进度，支持取消和新建对话；终态 Markdown 整段返回，尚非模型 token 流。
6. 可复现评测：原 5 条继续兼容，新增 60 条合成 v1 案例，可离线跑真实 LangGraph，并设置通过率／P95 阈值。

## 试用

```bash
bash tools/start.sh
```

进入首页上传自己的试卷和可选答案，复核不确定题目后从阅读器“当前题目”提问。先看界面是否显示 LangGraph ready，再查看实际工具、来源和执行次数，不把“已经配置”当作真实模型可用。

翻译页选择已加载的“随着”等方法，先用“只提示下一步”，再尝试“检查这一段”。个人资料授权默认关闭；只有明确打开才提供有限私人内容。撤销授权时等待旧服务端记忆清除确认，失败不宣称已删除。

```bash
env DEEPSEEK_API_KEY= CET_AGENT_URL= CET_EMBEDDING_URL= .venv-agent/bin/python -m unittest discover -s tests -v
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --offline --min-pass-rate 1 --json
npm run test:browser
```

离线评测明确不继承真实模型配置；动态工具／语义 paraphrase 用 mock 模型另测，不能用离线通过率声称真实 DeepSeek 教学效果已验证。

## 尚未完成／必须明确的边界

- 当前未安装语义模型权重。默认为 `lexical_hash`，可按 [本地 Embedding 说明](../services/embeddings/README.md) 显式准备模型；不自动下载。没有真实模型测量时不声称召回提升。
- 只有题目 scope 可走 LangGraph；general／selection 仍直连 DeepSeek，无服务端题目记忆。
- 来源文本匹配不是语义蕴含，答案标记不是教学质量；token 缺报是未知成本。评测定义见 [Evals](../evals/README.md)。
- 取消只阻止后续工作，已经发送的付费请求可能完成和计费；不会承诺退款。
- 这是本机单用户系统，不是账号鉴权、租户隔离、云同步或完整个人学习画像；磁盘备份不在记忆 clear 范围内。
- 复核仍是建议＋人工表单／ETag 发布，不是可恢复的 LangGraph interrupt/resume 审批。

下一步优先用人工标注的真实资料测 Recall@k/MRR、来源结论支持度和提示质量；经授权测真实模型延迟／token，再考虑长期错因档案、监控和多租户部署，不急于堆多 Agent 或框架名称。

实现入口：[平台适配](../server/platform.py)、[工具循环](../services/agent/app.py)、[工具白名单](../services/agent/runtime_tools.py)、[会话记忆](../services/agent/conversation_memory.py)、[混合检索](../server/retrieval.py)、[SSE](../server/chat_stream.py)、[联动启动](../tools/start_platform.py)。详细安全边界见 [Agent 架构](agent-architecture.md)。
