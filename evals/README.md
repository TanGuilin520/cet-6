# CET Agent Evals

两套合成、无真题版权内容的契约案例：

- `agent_cases.jsonl`：原有 5 条兼容案例，仍是默认输入；
- `agent_v1_cases.jsonl`：60 条 v1 案例，覆盖官方解析、资料缺失／冲突、选项帮助、翻译／写作／方法辅导、私人授权和只读修改边界。

案例只验证所含情形，不用条数代表生产覆盖率。动态工具循环、本地 semantic paraphrase 另由 mock 模型／编码器单测验证；离线案例不访问真实 DeepSeek、不下载模型、不衡量实际语义模型召回。

## 先验证，再离线运行

```bash
.venv-agent/bin/python tools/run_agent_evals.py --validate-only
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --validate-only
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --offline --json
```

`--validate-only` 只校验 JSONL，不执行回答。`--offline` 用已安装的真实 LangGraph、临时 checkpoint 和显式空模型配置运行，不继承本机环境的付费 Key，走确定性路径。需要先明确安装 `.venv-agent` 依赖。

## CI 阈值

```bash
.venv-agent/bin/python tools/run_agent_evals.py \
  --cases evals/agent_v1_cases.jsonl --offline \
  --min-pass-rate 1 --max-p95-ms 1000 --json
```

通过率阈值为 0～1，默认 1；P95 阈值可选，按 CI 硬件测量设置。1000ms 是用法示例，不是产品 SLA。未达阈值返回 1，案例／参数无效返回 2。

## 对运行中的模型评测（可能计费）

不加 `--offline` 时请求指定 sidecar；若它配置真实 Key，多轮决策可能产生多次模型调用并计费。执行前明确确认环境和预算：

```bash
CET_AGENT_URL=http://127.0.0.1:8770 \
CET_AGENT_TOKEN='与sidecar相同的Token' \
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --json
```

## 如何解读指标

- `passRate`：schema、路由、只读、资料绑定和安全断言通过比例；
- `latencyMs`：本次所选模式的平均值、P50、P95，不混同线上模型耗时；
- `citationSourceMatchRate`：引用文字能否在来源片段中找到；不证明回答每项结论被支持，不是 semantic faithfulness／entailment；
- `answerMarkerMatchRate`：是否含预期答案标记，不是完整答题正确率或教学质量；
- `observedTotalTokens`：只加总上游报告 usage；缺报为未知，不能视为零成本。`reportedCases` 是有报告的案例数量。

报告不输出 API Key、私人原始上下文或隐藏推理。后续可以加人工参考解释、检索 Recall@k/MRR、结论支持度、提示质量和版本对比；暂不用现有机械指标冒充这些能力。
