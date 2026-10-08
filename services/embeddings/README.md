# 可选本地语义检索服务

主服务默认使用 BM25 + 本地哈希词项检索（界面明确标为 `lexical_hash`），
不是语义 Embedding。此服务只读取管理员明确指定的本地模型目录，不自动下载
模型，不访问付费 API，不接受客户端指定网址/模型/路径。没有模型时原平台仍可用。

在 Python 3.11 虚拟环境中明确安装可选依赖：

```bash
python3.11 -m venv .venv-embeddings
.venv-embeddings/bin/python -m pip install -r services/embeddings/requirements.txt
```

自行准备受信任、完整的 SentenceTransformer 模型（例如支持中英双语的 BGE-M3，
也可以选择较小的多语言模型），放在绝对路径目录。需要 `config.json`、
tokenizer 资源以及 `.safetensors` 权重；只支持白名单内置模块，不加载远程/自定义代码。
请使用导出的实体文件，而不是指向目录外的符号链接。模型文件可能很大，
本项目不会下载；CPU 性能、内存与实际召回效果需要用你的资料测量。

```bash
.venv-embeddings/bin/python -m services.embeddings.app --model-dir /absolute/local/models/bge-m3
```

可通过 `--reranker-dir /absolute/local/models/reranker` 额外指定本地 CrossEncoder，
缺失/加载失败只关闭重排序。服务仅监听 `127.0.0.1:8780`，
`GET /healthz` 显示真实模型 readiness，后台模型加载完成前返回 `ready:false`。
首次启动会计算模型内容指纹；更换文件后必须重启服务，避免缓存混用。

主服务环境设置（可放在项目 `.env`，不要提交个人配置）：

```dotenv
CET_EMBEDDING_URL=http://127.0.0.1:8780
```

重启主服务后生效。可选 `CET_EMBEDDING_TOKEN` 必须在两个服务设置相同值。
只允许数字 loopback HTTP 地址，拒绝 HTTPS、公网、凭据 URL、跳转和系统代理。
不设置 `CET_EMBEDDING_URL` 时不访问任何服务；配置后每 10 秒缓存 health 结果。

检索先绑定题号/方法 ID，再融合 BM25、哈希词项、可用的本地 dense 结果（RRF）。
每次调用最多生成 128 个新的文档向量，已缓存的整个版本仍可检索；首次大型资料
覆盖不完整时明确标记 `hybrid_semantic_partial`。新向量分批生成，8 秒索引预算到期
不再开始新的批次（已经开始的单次 HTTP 有独立超时）；服务繁忙时拒绝排队。
失败退回词项检索，不把哈希冒充语义模型。可选 reranker 只重排补充证据，
不改变题号精确证据的优先级。

`data/retrieval/semantic.sqlite3` 仅保存文档/命名空间/模型指纹和向量，不保存正文。
索引按试卷 ID + 资料 revision 隔离，更换模型、维度或正文不会复用旧向量；损坏缓存
保留不覆盖。个人授权笔记应使用 `persist=False`，只在当前请求内检索，不写入此索引。

接口规范与离线加载参数依据：[SentenceTransformer 官方文档](https://www.sbert.net/docs/package_reference/sentence_transformer/model.html)
和 [CrossEncoder 官方文档](https://www.sbert.net/docs/package_reference/cross_encoder/model.html)。
