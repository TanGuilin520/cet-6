# CET 英语学习平台

一个无需前端构建工具的本地英语在线试卷平台。平台只提供工具，试卷 PDF、可选答案 PDF 和听力音频由用户自行上传；不提供默认真题、模拟试卷或听力资料。支持自动解析、完整试卷阅读、答题、笔记，以及可选的 LangGraph Agent 辅导与复核运行层。

完整卷以原 PDF 页面图像保持版式，并叠加可选择的文字坐标层、SVG 标注层和题目交互层。用户上传与生成资源保存在本机 `data/exams/`。历史参考资料仍保留，避免破坏已有文件，但默认不作为平台内容公开。

## 1. 功能

- **完整试卷**：按用户上传 PDF 的实际页数连续展示，支持缩略图、翻页、缩放、适合宽度和原 PDF 下载。
- **统一整卷入口**：首页只展示解析完成的用户上传卷，全部进入同一个 `reader.html`，共享答题、AI、听力、写作模板和标注能力。没有上传时引导首次上传；服务不可用时显示重试入口，不回退演示卷。同一 PDF 的不同上传记录不会按哈希隐藏。
- **上传即解析**：上传试卷 PDF、可选答案 PDF 和听力音频，由服务器自动生成页面图、文字坐标、题目、答案与检索索引；整卷 JPG 使用一次 Poppler 批量渲染，避免逐页重复启动进程。
- **扫描件适配**：优先读取 PDF 文字层；无文字或混合扫描页可调用独立 PaddleOCR sidecar，并继续保留 OCRmyPDF/Tesseract 回退。上传页会显示当前 OCR 能力。
- **解析复核工作台**：集中处理缺题、低置信度题目和答案冲突，可在原卷页定位 bbox、补题、修正选项与答案，再以带版本和审计记录的原子修订发布。
- **AI 复核建议**：可选 Agent 对当前 issue 和锁定 revision 生成带证据的字段级建议；建议只会进入预览，用户明确应用到表单、核对并填写理由后才能通过原有 ETag 流程保存。
- **在线答题**：在原卷外侧预留独立答题轨道，默认只显示题号和已选答案；点击题号才展开 A/B/C/D，不覆盖 PDF 内容，并支持题号导航、待复查、定位和自动保存。
- **作文工作台与个人模板库**：从原卷进入 `writing.html` 时展示可确认的当前作文题目，默认按开头、主体、结尾三段编辑；完整正文模式保留已有多段模板。“本题作答”与“我的模板”分别保留草稿，模板复制不会改写模板库。支持词句填空、选区转换、实时成稿与估算词数，字数范围只依据原题明确要求；完成后先预览、确认，再应用到已验证的本题。支持专注模式、小屏编辑／模板／预览切换，以及 TXT/Markdown 导入、原模板 MD 和成稿 TXT 导出。
- **翻译工作台**：`translation.html` 采用左侧方法目录、中间翻译练习、右侧原始方法与例句的三栏布局；小屏可切换练习／方法／资料。首次空白进入带入可确认的原文及本题已有作答，不覆盖已有输入。原句、初译、修改后、修改原因、使用方法和自由笔记均可选；保存笔记不提交答案，需单独预览并确认“应用到本题”。无真实、已验证题号时只能保存笔记，不会生成虚构答案键。
- **翻译总结整合与方法辅导**：点击“加载 GitHub 笔记”显式读取指定的 [CET6-Translation-Notes](https://github.com/TanGuilin520/CET6-Translation-Notes) `master/翻译.md`，按实际 18 节保留原文；目录查找、方法例句与个人资料保持独立。记录的方法带有来源与 ID，可查自己的历史应用。翻译 AI 支持提示下一步、检查译文和依据方法分析；方法检索先精确 ID，再以 BM25／哈希词项及可选本地语义向量补充，个人资料及历史笔记须显式授权，不冒充官方解析。普通打开页面不自动下载或调用 AI。
- **表达库与学习记录**：收藏自己的词句，记录用途、标签、来源和例句，随时插入当前段落。`learning.html` 汇集跨试卷笔记、翻译对照、作文草稿与表达，支持按类型／试卷及关键词、标签、方法查找，隐藏结果重练，再展开对照；支持筛选记录 Markdown 导出与本机 JSON 备份、确认后合并恢复。
- **对应题型入口**：作文模板、翻译方法入口位于原卷对应写作题、翻译题左侧；蓝色“翻译”题号本身也是链接，点击即进入翻译工作台，不再先展开作答面板。入口与题目位置一起缩放和定位，不遮住正文或高亮，不在无关页面重复显示。优先采用已解析题目坐标；题号缺失时可根据明确的 Writing／Translation 标题定位，不猜题号或页码。顶部仍有全局入口。返回时优先定位真实题号，否则恢复原页，跳转前保存原有作答及笔记草稿。
- **居中缩放**：原卷两侧预留对称轨道，以阅读区域中央为基准放大、缩小和适宽；超宽时可手动横向移动，下次缩放重新居中，同时保留当前纵向阅读位置。
- **答案与批改**：答案只从上传答案 PDF 的明确标记绑定，不硬编码；冲突或越界答案不会进入客观题批改。
- **按题 Agent 辅导 v1**：先按 Question ID 精确绑定答案。LangGraph 在模型可用时由模型按需选择六种只读工具，执行有界的“决策 → 工具 → 补查／回答”循环；没有模型时走确定性流程。独立 Run checkpoint、按题会话记忆、来源引用、执行次数与真实运行状态可查看；没有自动改答案工具。自由／选段模式仍是主服务直连 DeepSeek，不宣称全部聊天都经过 Agent。
- **可取消的 AI 进度**：阅读器和翻译页通过 SSE 显示真实节点／工具进度，支持停止生成和新建对话。最终 Markdown 仍整段返回，不是模型 token 流。取消只阻止后续工作与界面保存，不能撤回已发送的模型请求或保证退款。
- **Agent Evals**：保留原 5 条兼容案例，新增 60 条合成 v1 案例，支持真实 LangGraph 零模型网络的离线评测、通过率／P95 阈值、引用原文匹配与答案标记检查；这些机械指标不是语义忠实度或教学质量评分。
- **听力播放**：同源音频流支持播放、暂停、进度、音量、HTTP Range 与 0.75×–2.0× 倍速。
- **点击查词**：在“查词 / 笔记”模式单击英文单词，朗读并显示中文释义；点击已高亮的单词可从工具条查词或修改高亮颜色。
- **选段复制**：切换“选段复制”后拖选同一页文字，可在确认面板复制纯文本；浏览器拒绝剪贴板权限时保留手动复制入口。
- **笔直画线**：直线工具只记录起点和终点，拖动时预览，松开后得到一条标准直线。
- **矩形荧光笔**：先自由选择颜色，再拖选英文文字；系统按实际单词边界和行生成规整长方形，每条标注独立保存颜色，不会形成手绘曲线。
- **选段笔记**：拖选后保留原文选区，浮动工具条支持复制、高亮、笔记和问 AI；笔记正文优先输入，支持 6000 字和可选标签。桌面编辑时为右侧笔记面板预留空间。
- **草稿恢复**：收起编辑器、切换工具或刷新页面后可继续未保存的笔记；多条草稿独立保留，正式笔记保存成功后才清除对应草稿。草稿只保存在当前浏览器。
- **标注管理**：直线、荧光标记和笔记按页保存到 `localStorage`，支持橡皮擦、会话内撤回与重做；擦除时只移除命中节点，松手后更新侧边栏。

方法检索、授权的个人笔记辅导、跨试卷搜索与主动重练已实现，具体边界见 [学习方法与笔记产品方案](docs/learning-methods-product-plan.md)。任意仓库导入、逐卡个人修订、原文选区／方法／错因完整双向关联、听力时间点笔记与自动间隔复习仍未实现。学习资料保留整理者和课程来源，明确为个人笔记而非官方解析；完整原文仅在用户本机运行缓存中，不随公开平台代码分发。当前没有登录、云同步或多用户隔离。

## 2. 目录结构

```text
.
├── public/                            # 浏览器可直接访问的静态资源
│   ├── index.html                     # 试卷库首页
│   ├── upload.html                    # 试卷、答案和音频上传页
│   ├── review.html                    # 题目与答案解析复核工作台
│   ├── reader.html                    # 用户上传试卷的统一阅读器
│   ├── writing.html                   # 个人作文模板库与填空工作区
│   ├── translation.html               # 方法目录、翻译对照练习与例句
│   ├── learning.html                  # 跨试卷查找、重练、表达与备份
│   ├── practice.html                  # 历史演示页，默认禁止访问
│   ├── css/
│   │   ├── home.css
│   │   ├── upload.css
│   │   ├── review.css
│   │   ├── reader.css                 # 完整卷阅读器样式
│   │   └── practice.css               # 单篇练习样式
│   ├── js/
│   │   ├── home.js
│   │   ├── upload.js                  # 上传、状态轮询和最近试卷
│   │   ├── review.js                  # 复核筛选、编辑和版本提交
│   │   ├── reader.js                  # 完整卷分页与标注逻辑
│   │   ├── translation.js             # 本题原文、个人资料与对照笔记
│   │   ├── translation-methods.js      # 方法目录搜索与安全 Markdown 展示
│   │   ├── learning-store.js           # 本地表达、答案合并与学习备份
│   │   ├── learning.js                 # 学习记录筛选、重练和导出恢复
│   │   └── practice.js                # 单篇练习逻辑
│   └── assets/
│       ├── papers/2021-06-set-01/     # 历史测试资源，默认禁止访问
│       └── audio/                     # 预置及动态生成的单词音频
├── server/                            # Python 服务端代码
│   ├── __init__.py
│   ├── __main__.py                    # python -m server 入口（需 3.11+）
│   ├── app.py                         # 静态服务、TTS、DeepSeek 代理
│   ├── agent_client.py                # 到 Agent sidecar 的受限适配器（Python 3.11）
│   ├── paddle_ocr.py                  # PaddleOCR sidecar 客户端（Python 3.11）
│   ├── learning_methods.py            # 固定公开学习资料的显式导入与缓存 API
│   ├── retrieval.py                   # BM25/哈希 + 可选本地语义/RRF/重排序
│   ├── chat_stream.py                 # 有界 SSE 进度、结果与协作取消
│   └── platform.py                    # 上传、PDF/OCR、复核、RAG 与资源 API
├── services/agent/                    # Python 3.11 LangGraph Agent runtime
├── services/embeddings/               # 可选离线本地语义模型服务（不自动下载）
├── services/paddleocr/                # 隔离运行的 PaddleOCR 3.7 服务
├── data/agent/                        # Agent SQLite checkpoint（Git 忽略）
├── data/exams/                        # 上传与生成的运行数据（Git 忽略）
├── data/learning-methods/             # GitHub 原文与来源信息缓存（Git 忽略）
├── data/retrieval/                    # 按资料版本/模型指纹隔离的语义向量缓存
├── data/reference/2021-06/            # 归档的 PDF、MP3 参考资料
│   ├── listening/
│   ├── papers/
│   └── answers/
├── evals/                              # 合成 Agent 黄金案例与使用说明
├── tools/
│   ├── build_exam_assets.py           # PDF 页面图与文字坐标生成工具
│   ├── start.sh / start_platform.py   # 主服务 + 可用的本机 Agent 联动启动
│   └── run_agent_evals.py             # Agent 契约、策略与延迟评测
├── .env.example                       # DeepSeek 与可选 sidecar 配置模板
├── docker-compose.agent.yml           # Agent runtime 的本机隔离启动配置
├── docs/agent-architecture.md         # Agent 工作流、运行方式和安全边界
├── docs/agent-v1.md                   # 本轮 Agent v1 的能力、验证及未完成边界
├── docs/platform-architecture.md      # 平台流程、数据与技术边界
├── tests/                             # 平台、Agent 协议与安全回归测试
├── .gitignore
└── README.md
```

根目录只保留项目级配置、说明和一级功能目录。`__pycache__/`、`.env` 和 `public/assets/audio/cache/` 属于运行产物或本地配置，已加入忽略规则。

## 3. 启动项目

### 前置条件

- Python 3.11（全项目统一目标版本，见 `.python-version`；主服务在低于 3.11 的解释器上会拒绝启动，3.12+ 兼容但 CI 固定 3.11）
- 不要替换或删除 Ubuntu 系统自带的 `/usr/bin/python3`；用虚拟环境提供 3.11：

```bash
python3.11 -m venv .venv-main
```

以下文档命令统一假设使用 `.venv-main/bin/python`（或 Docker）运行主服务。
- 现代浏览器
- Python 主服务本身使用标准库，不需要安装 Python 第三方包
- 上传解析需要 Poppler：`pdftotext` 与 `pdftoppm`
- 扫描版 PDF 可使用独立 PaddleOCR sidecar，或 OCRmyPDF，或 Tesseract + Poppler；中文答案建议启用中文模型/`chi_sim`
- `flite` 是可选依赖：安装后可为未预置的英文单词生成 WAV；未安装时网页会尝试浏览器语音

### 启动

在项目根目录执行（需要 Python 3.11；系统解释器过低时主服务会拒绝启动并给出提示）：

```bash
bash tools/start.sh
```

启动脚本使用项目的 `.venv-main`，并隔离可能来自 ROS 等环境的 `PYTHONPATH`。它调用 `tools/start_platform.py`：已安装 `.venv-agent` 依赖时，自动启动本机 Agent，再启动原主服务；为两个自建子进程共享本次随机 Token，不写 `.env`、不安装依赖、不下载模型、不调用 LLM。已有同 Token 的 ready runtime 可复用，8770 被其它服务占用时不接管；退出只清理本次启动的子进程。保持这个终端运行。

`.venv-main/bin/python -m server` 仍是只启动主服务的手动入口；想临时关闭联动可用 `CET_MANAGED_AGENT=0 bash tools/start.sh`。手动设置了 `CET_AGENT_URL` 时启动器保留该配置，不再自动启动 sidecar。

不启动服务也可以检查解释器、密钥配置来源和 Agent 配置：

```bash
bash tools/start.sh --check
```

该检查不会调用 DeepSeek，不会输出密钥，也不代表凭证或余额已通过验证。

然后打开：

- 首页：<http://127.0.0.1:4173/>
- 导入试卷：<http://127.0.0.1:4173/upload.html>
- 作文模板：<http://127.0.0.1:4173/writing.html>
- 翻译工作台：<http://127.0.0.1:4173/translation.html>
- 学习记录与备份：<http://127.0.0.1:4173/learning.html>
- 解析复核：上传完成后点击“复核解析”，或访问 `review.html?exam=<examId>`
- 我的试卷：从首页选择自己的上传记录，或访问 `reader.html?paper=<examId>`

直接访问没有 `paper` 参数的阅读器会跳转上传页；旧演示链接不会加载内置内容。历史 `/api/papers/*`、`/assets/papers/*` 和 `practice.html` 默认返回 404。开发者可通过 `CET_ENABLE_DEMO_PAPERS=1` 临时启用旧后端兼容资源作回归测试，但首页和阅读器不恢复默认演示入口。

TTS 和 DeepSeek 都依赖 Python 服务，直接在 `public/` 中运行静态文件服务器时不会提供这些接口。

端口被占用时：

```bash
.venv-main/bin/python -m server --port 4174
```

再访问 <http://127.0.0.1:4174/>。

## 4. 配置 DeepSeek

复制模板：

```bash
cp .env.example .env
```

编辑项目根目录的 `.env`，把下面这一行替换成自己的密钥：

```dotenv
DEEPSEEK_API_KEY=你的真实 DeepSeek API 密钥
DEEPSEEK_MODEL=deepseek-v4-flash
```

当前官方模型为 `deepseek-v4-flash`（默认，低延迟）与 `deepseek-v4-pro`（可选，更复杂回答）；已弃用的 `deepseek-chat` / `deepseek-reasoner` 会在启动时映射到新模型并打印一次不含密钥的提示。

保存后重启联动服务（先在旧终端 Ctrl+C）：

```bash
bash tools/start.sh
```

密钥只由 Python 服务读取；网页源码、浏览器请求头和 `localStorage` 中不保存密钥。`.env` 已被 `.gitignore` 忽略。

环境变量优先于 `.env`，包括显式设置为空的变量。如果 `--check` 显示 `deepseekKeySource=environment`，但你希望使用项目 `.env` 的密钥，可仅对本次启动移除继承值：

```bash
env -u DEEPSEEK_API_KEY bash tools/start.sh
```

也可以使用环境变量：

```bash
DEEPSEEK_API_KEY='你的真实密钥' DEEPSEEK_MODEL='deepseek-v4-flash' .venv-main/bin/python -m server
```

### DeepSeek 接口

网页调用同源接口：

```http
POST /api/deepseek
Content-Type: application/json

{
  "model": "deepseek-v4-flash",
  "messages": [
    {"role": "user", "content": "请解释 flexible 在本文中的含义。"}
  ]
}
```

也可以省略 `model`，由服务器按 `CET_AGENT_DEEPSEEK_MODEL → DEEPSEEK_MODEL → deepseek-v4-flash` 选择默认值。

成功响应：

```json
{"reply":"……"}
```

服务端固定请求 DeepSeek 官方 Chat Completions 地址，并限制请求体大小、消息数量、单条文本长度和消息角色。也兼容 `POST /api/chat`。

AI 助手支持三种对话模式，通过请求中的 `scope` 字段选择：`question`（当前题，题号精确检索 + 答案 PDF 优先）、`general`（自由提问，不读取答案资料、不声称官方解析）、`selection`（针对选中文本提问，最多 8,000 字符）。旧请求不带 `scope` 但带 `questionId` 时仍按题目模式处理。模型只被允许返回 `{"reply": "面向用户的 Markdown"}` 信封；后端负责解析与校验，非法输出安全降级为确定性提示，浏览器永远不会看到原始 JSON。

### 可选 PaddleOCR

PaddleOCR 不安装进主服务环境，而是使用独立的 `.venv-paddleocr`（Python 3.11）或 Docker 运行。这样即使模型服务未启动，文字型 PDF 和原有 OCR 回退仍能工作。

完整安装、Docker volume、共享目录和 Token 配置见 [PaddleOCR sidecar 说明](services/paddleocr/README.md)。启动 sidecar 后在 `.env` 中配置：

```dotenv
CET_PADDLEOCR_URL=http://127.0.0.1:8765/v1/ocr
CET_PADDLEOCR_TOKEN=与sidecar相同的Token
CET_PADDLEOCR_LANGUAGE=en
CET_PADDLEOCR_SHARED_ROOT=/absolute/path/to/cet-6/data/exams
```

`/api/exams/capabilities` 只有在 sidecar Token、共享目录、Paddle 运行时和所选语言都满足调用前提时，才会把 PaddleOCR 报告为可用，并单独返回 `modelLoaded`。健康检查不会为了探活下载模型；首次真实识别可能下载并载入模型，耗时会明显高于后续请求。当前开发机没有安装数 GB 的 Paddle 模型，默认继续使用文字层或已安装的本机 OCR 回退。

### 可选 LangGraph Agent

Agent 依赖不安装进主服务环境，而是使用独立的 `.venv-agent`（同样是 Python 3.11，依赖隔离）。只需显式安装一次，然后用同一个启动入口：

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r services/agent/requirements.txt
bash tools/start.sh
```

启动器从主服务环境／项目 `.env` 获取模型配置，仅向子进程传递密钥，不打印密钥；`/api/exams/capabilities` 与聊天面板显示 Agent 是否实际 ready。健康检查不访问 DeepSeek，配置存在不等于 API 余额、权限或模型效果已验证。没有 Key 仍可运行保守只读流程。

需要分开管理时使用下面的手动方式；sidecar 自身不自动读取项目 `.env`：

```bash
CET_AGENT_TOKEN='替换为随机Token' \
CET_AGENT_CHECKPOINT_PATH="$PWD/data/agent/checkpoints.sqlite3" \
DEEPSEEK_API_KEY='你的真实密钥' \
.venv-agent/bin/python -m services.agent.app --host 127.0.0.1 --port 8770
```

也可以使用隔离容器启动（端口只绑定本机，checkpoint 使用独立 volume）：

```bash
docker-compose -f docker-compose.agent.yml up --build -d
```

随后在项目 `.env` 配置同一个 Token 和 sidecar 地址：

```dotenv
CET_AGENT_URL=http://127.0.0.1:8770
CET_AGENT_TOKEN=替换为与sidecar相同的随机Token
CET_AGENT_TIMEOUT_SECONDS=40
```

手动启动主服务后，`/api/exams/capabilities` 的 `agent.ready` 应为 `true`。未配置 Agent 时题目仍可由主服务直连 DeepSeek；Agent 已配置但请求失败时只给安全失败／资料提示，不再隐式发起第二条付费模型请求。Review 仍可手动完成。

模型循环最多 4 轮、12 次工具调用和 30 秒，约 8,000 token 的估算／上游报告预算是保守保护，不是账单上限保证。会话按题保留最近 6 轮及 1,200 字符提取式摘要；资料 revision 或授权私人内容变化会清除旧会话范围。新建对话、撤销个人授权会明确请求删除旧服务端记忆；失败时保留待删除标记，不把旧记忆当作已清理。它仍是本机单用户存储，不是账号鉴权或云同步。

完整拓扑见 [Agent 架构](docs/agent-architecture.md)，内部契约见 [runtime 说明](services/agent/README.md)，本轮边界见 [Agent v1](docs/agent-v1.md)。

### 可选本地语义检索

默认检索为 BM25 + 哈希词项，状态明确显示 `lexical_hash`，不冒充语义模型。可按 [本地 Embedding 服务说明](services/embeddings/README.md) 显式安装可选依赖、准备本地模型实体文件，再设置 `CET_EMBEDDING_URL=http://127.0.0.1:8780`。不会自动下载 BGE 或其它权重，当前未预装语义模型。

模型 ready 时使用 dense + BM25 的 RRF，并可启用本地重排序；保持题号／方法 ID 精确优先。缓存绑定试卷／资料版本、模型指纹、维度及正文；损坏缓存不覆盖。每次最多生成 128 个新文档向量，覆盖不完整会显示 `hybrid_semantic_partial`。个人授权笔记只在当前请求内排序，不持久化到语义索引。

## 5. 使用流程

1. 打开“导入试卷”，选择试卷 PDF；答案 PDF、听力音频和试卷名称可以留空。
2. 点击“上传并生成试卷”，等待文字检测、页面生成、结构解析、答案绑定和索引完成。
3. 查看可靠、建议检查、人工确认及未识别数量；有待处理项时先进入“复核解析”。启用 Agent 后可获取字段级建议，但必须人工点击“应用到表单（不会保存）”、对照原卷核查并填写修改理由。
4. 发布复核版本后进入阅读器。点击原卷左侧题号展开或收起 A/B/C/D；选中后，题号旁会直接显示当前答案。也可用右侧题号导航定位、标记待复查；提交后只批改有明确答案绑定的客观题。
5. 点击右下角“问 AI”打开常驻题目助手；切换题号时窗口自动跟随当前题，各题对话互不混用，桌面端可以最小化。
6. 点击原卷作文旁蓝色“作文模板”进入工作台，顶部带入可确认的原题；真实题号优先，没有题号则只从对应页明确 Writing 标题及坐标提取，不猜题目。“本题作答”与“我的模板”分开保留，复制模板不会回写原模板。默认开头、主体、结尾三段，也可用完整正文保留已有多段；正文可设 `{{主题}}` 等词句填空，并实时预览。点击“保存本题草稿”保留，完成后预览并确认应用到已验证的本题；复用内容可“另存为我的模板”。导入 UTF-8 TXT/MD 最大 64KB，合并正文最多 12,000 字符、40 个不同填空、每项最多 1,000 字符，模板库最多 30 份。词数仅估算，范围只依据原题明确要求；无题号时不能提交，但可保存页级草稿并返回原页。
7. “查词 / 笔记”中拖选文字会显示浮动工具条，点击“笔记”后直接输入正文；Ctrl/⌘+Enter 保存，收起后可从“继续未保存的笔记”恢复草稿。“选段复制”仍提供复制确认面板，荧光笔模式支持连续拖选高亮。Ctrl/⌘+Z 撤回标注，Ctrl/⌘+Shift+Z 或 Ctrl/⌘+Y 重做；在输入框中这些快捷键交给文字编辑。
8. 点击原卷左侧蓝色“翻译”题号，直接进入翻译工作台；翻译题旁的方法入口、顶部和作答区入口同样可用。没有解析出题号但识别出明确题型标题时也可从对应页进入，无法确定位置时使用顶部全局入口。没有本题笔记／草稿且尚未输入时，工作台带入可确认的中文原文；绑定真实题号时，也会带入这道题已有作答作为初译，不读取其他题目答案。已有笔记保持不变；“重新载入原题”只替换原句，有内容时先确认。
9. 在左侧加载 GitHub 笔记，搜“随着”等关键词，对照原始说明和例句；“记录本次使用”同时记录名称、来源与方法 ID。需要辅导时点击提示／检查／方法分析；只有勾选本次授权，才附带有限的个人方法和相关历史笔记。撤销授权会清除后续请求的对话上下文，但不能撤回已发出的请求；没有配置 AI 时明确提示，不编造辅导。
10. “我的资料”支持自己的 UTF-8 TXT/MD（最大 64KB、24,000 字符），GitHub 目录不覆盖它。对照笔记各字段可选、各最多 12,000 字符，本机最多 200 份；保存笔记与交卷独立。作文、翻译完成后可先预览再确认应用到已验证的本题，覆盖旧答案需确认；题目版本变化或另一窗口改过同题时拒绝静默覆盖。
11. 打开“学习记录”查找跨试卷笔记、方法应用和表达；开启重练模式先隐藏结果，尝试后再展开。可导出筛选记录 Markdown 或 JSON 整库备份；恢复只接受不超过 8MB 的本平台备份，先预览、确认，关闭其他编辑页面，再合并。同标识记录使用备份版本；确认恢复前页面先触发下载现有本机备份。

首页的“继续练习”只关联真实上传卷已有的学习记录，不会凭空显示练习进度。没上传答案仍可阅读、作答和记笔记，但缺少明确答案的题目不能自动批改；没上传音频则不显示听力播放器。

完整卷的作答、写作模板、标记、分题对话、荧光颜色与标注保存在当前浏览器的 `localStorage` 中，不会自动同步到其他设备。历史记录不会被此次入口调整清除。模板文件只在浏览器本地读取，不会上传服务器，也不会自动发送给 AI；复制面板中的临时文本不会持久化。上传的试卷资料与生成资源保存在服务端本机的 `data/exams/`。

GitHub 方法原文保存在服务端本机 `data/learning-methods/translation-notes.json`，不放入 `public/`，不提交 Git。来源、加载时间、SHA-256、整理者与课程归因保留，例句不改写，不当作官方标准答案。方法 RAG 只读本机缓存，先 ID 精确检索，再用 BM25／哈希及明确配置的可选本地语义模型补充；个人资料只来自授权请求。只有题目 scope 使用 LangGraph，自由／选段 scope 仍是主服务直连。

JSON 备份可能包含个人方法、笔记、草稿、表达、标注、试卷作答及试卷状态内的对话记录，不含服务端 PDF／音频文件或服务器密钥；请妥善保存，不要公开提交 GitHub。备份与恢复只处理学习资料白名单分区，合并不删除未包含记录；失败会尝试回滚，若浏览器存储也阻止回滚会明确提示，恢复前请确认下载备份已保存。

模板库属于当前浏览器，不是登录账户的云空间。同一浏览器配置文件的使用者共享本地库；需要分别保存时使用各自浏览器配置文件。导出原模板 MD 保留占位符，适合再次导入；导出 TXT 保存当前填入的表达。写作题复制库模板后单独保存本题填空，修改不会自动回写模板库；“另存到我的模板库”会创建新模板。只有点击“应用到作文”才更改答案，覆盖已有作文前必须确认。

## 6. 接口与资源

| 地址 | 方法 | 作用 |
| --- | --- | --- |
| `/api/exams/upload` | POST | 上传试卷、答案和音频，返回异步任务 |
| `/api/exams` | GET | 最近导入的试卷 |
| `/api/exams/capabilities` | GET | OCR、Agent／SSE／记忆及可选语义检索的真实 readiness |
| `/api/exams/{id}/status` | GET | 解析阶段、进度、错误与结果地址 |
| `/api/exams/{id}/manifest` | GET | 页面图和透明文字坐标 |
| `/api/exams/{id}/questions` | GET | 题目、结构、置信度与未识别项；返回复核 ETag |
| `/api/exams/{id}/answers` | GET | 明确答案、解析和冲突项；可用 `If-Match` 锁定同一复核版本 |
| `/api/exams/{id}/review` | GET/PATCH | 读取复核数据；按 ETag 原子发布修订 |
| `/api/exams/{id}/audio` | GET/HEAD | 支持 Range 的听力音频 |
| `/api/exams/{id}/assistant` | POST | 题目／自由／选段助手；可选学习资料授权、方法引用及题目 Agent 工具轨迹 |
| `/api/exams/{id}/assistant/stream` | POST | 同一助手请求的 SSE 节点进度、最终结果及协作取消；不是另一条模型请求 |
| `/api/exams/{id}/assistant/conversations/clear` | POST | 本机明确删除已验证题目会话及其关联 checkpoint；自由／选段无服务端会话 |
| `/api/exams/{id}/agent/review-suggestions` | POST | 为当前 issue/revision 生成只读字段建议，不保存复核 |
| `/api/learning-methods/translation-notes` | GET/HEAD | 只读取本机学习资料缓存；缺失时返回 `not_imported`，不联网 |
| `/api/learning-methods/translation-notes/refresh` | POST | 空 JSON `{}` 显式加载／刷新固定公开 Markdown，不接受用户网址 |
| `/api/tts?word=WORD` | GET/HEAD | 生成或读取英文单词 WAV |
| `/api/deepseek` | POST | DeepSeek 对话代理 |
| `/api/chat` | POST | DeepSeek 对话代理兼容路径 |

预置音频位于 `public/assets/audio/`；动态音频缓存位于 `public/assets/audio/cache/`，删除后会在下次请求时重新生成。

完整卷的中文释义在浏览器中调用 MyMemory 公共英中翻译接口，并使用会话内缓存；接口不可用时，词卡仍可继续朗读。

## 7. 常见问题

### 点击单词没有声音

确认页面由 Python 3.11 的 `.venv-main/bin/python -m server` 提供，检查浏览器标签页的静音状态和系统音量。预置词使用 `public/assets/audio/*.wav`；其他词需要本机安装 `flite`，否则会使用浏览器语音合成。

### AI 助手提示未配置

确认 `.env` 位于项目根目录、`DEEPSEEK_API_KEY` 已填写，停止旧服务并重新运行 `bash tools/start.sh`。同时确认网络和 DeepSeek 账户额度可用；界面的运行状态和每次回答执行记录才是实际执行依据。

配置后，本题题干、用户问题和检索到的资料会发送给 DeepSeek；学习辅导还包含指定的方法及本次明确授权的个人资料。不要在未披露该边界时对外提供服务。未配置时不猜缺失解析，学习模式明确提示未生成辅导。

### AI 复核建议不可用

先访问 `/api/exams/capabilities` 检查 `agent`：`configured=false` 表示主服务没有配置 `CET_AGENT_URL`；`reachable=false` 表示 sidecar 未启动、Token 不一致或网络不可达；`ready=false` 通常表示 Python 版本、LangGraph 依赖或 checkpoint 目录有问题。建议接口失败不会自动改动表单或 revision，可以继续人工复核。

### 扫描版 PDF 解析失败

上传页会先显示服务器是否具备扫描卷能力。可以按 [PaddleOCR sidecar 说明](services/paddleocr/README.md) 启动 PaddleOCR，也可以安装 OCRmyPDF，或同时安装 Tesseract 与 Poppler。答案 PDF 含中文时建议启用 Paddle 中文模型或 Tesseract `chi_sim`。纯扫描卷缺少 OCR 能力时任务会明确失败；混合 PDF 会保留原生文字页，并在 manifest 中列出仍需人工检查的页面。

### 标注或答题状态消失

状态保存在浏览器 `localStorage`。无痕窗口、清理站点数据、更换浏览器或更换设备都会使用新的存储空间。

### 写作模板无法导入

模板只支持 1B–64KB 的 UTF-8 `.txt` 或 `.md` 文件，正文不能超过 12,000 个字符，并且至少包含一个 `{{名称}}` 占位符。二进制内容、NUL 字符或错误编码会被拒绝；模板替换后的作文也不能超过 12,000 个字符。

### 是否需要提前生成试卷资源

不需要。安装 Poppler 的 `pdftotext` 和 `pdftoppm` 后，用户直接在上传页提交 PDF，服务器自动处理。`tools/build_exam_assets.py` 仍保留为离线开发工具，但它生成的历史静态目录默认不向用户提供。

### 需要清理运行缓存

```bash
rm -rf public/assets/audio/cache server/__pycache__ tools/__pycache__
```

两者都会在需要时重新生成。

## 8. 开发检查

```bash
node --check public/js/home.js
node --check public/js/upload.js
node --check public/js/review.js
node --check public/js/reader.js
node --check public/js/agent-chat.js
node --check public/js/writing-templates.js
node --check public/js/writing.js
node --check public/js/writing-task.js
node --check public/js/translation.js
node --check public/js/translation-methods.js
node --check public/js/learning-store.js
node --check public/js/learning.js
.venv-main/bin/python -m py_compile server/app.py server/platform.py server/retrieval.py server/chat_stream.py server/learning_methods.py server/agent_client.py server/paddle_ocr.py server/__main__.py services/agent/app.py services/agent/runtime_tools.py services/agent/conversation_memory.py services/embeddings/app.py services/paddleocr/app.py tools/build_exam_assets.py tools/start_platform.py
env DEEPSEEK_API_KEY= CET_AGENT_URL= CET_EMBEDDING_URL= .venv-agent/bin/python -m unittest discover -s tests -v
.venv-agent/bin/python tools/run_agent_evals.py --validate-only
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --offline --min-pass-rate 1 --max-p95-ms 1000 --json
```

自动化测试使用独立的 `.venv-agent`（安装步骤见 Agent 配置章节），覆盖真实 LangGraph 图的编译和调用。`--validate-only` 只校验格式；`--offline` 显式清空模型配置，用临时 checkpoint 执行真实图，不继承本机付费 Key。P95 阈值示例需按 CI 硬件调整。60 条 v1 合成案例检查路由、资料绑定、只读、授权和来源文本匹配，不代表真实模型辅导质量；token 缺报视为未知，不当作零成本。详见 [评测说明](evals/README.md)。

浏览器回归使用 Node.js 和 Playwright；它们只用于开发测试，运行阅读器不需要前端构建：

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

浏览器测试启动隔离的本地服务并使用合成回复，覆盖空平台上传引导、目录失败重试、旧演示入口隔离、上传卷跳转、聊天刷新恢复、Enter/中文输入法、连续追问、选段提问、失败重试和安全渲染，以及原文选区工具条、长笔记与多草稿恢复、撤回/重做、存储失败、移动端编辑和批量擦除。另覆盖作文模板库的填空、导入导出、跨试卷复用、覆盖确认与异常数据防护，以及缩放居中、侧栏变化、异宽页面和纵向阅读位置保留。翻译相关回归使用合成学习资料，检查直接跳转、原文／已有作答带入与输入保护、方法加载失败重试、目录查找、个人资料独立保存和安全展示；后端导入测试用模拟 HTTP 覆盖固定来源、下载界限与缓存失败保护。测试不调用真实 DeepSeek，也不依赖真实 GitHub 下载；在 CI 中也会执行。失败时可查看 `playwright-report/` 和 `test-results/`，这些目录不进入 Git。

修改页面结构或工具栏后，建议在桌面和手机宽度各打开一次上传卷，回归检查实际页数加载、题号轨道展开与不遮卷、选段复制及权限降级、不同颜色荧光刷新恢复、直线、标签、橡皮擦、撤回、AI 开窗切题与写作模板导入/预览/覆盖保护。

完整 Pipeline、数据格式与 RAG 顺序见 [平台架构说明](docs/platform-architecture.md)；Agent 图、运行方式、公开契约与安全边界见 [Agent 架构说明](docs/agent-architecture.md)。

## 9. Git 使用

项目使用 `main` 作为主分支。`.env`、运行缓存和 `data/reference/` 下的大型 PDF/MP3 不会进入 Git；参考资料仍保留在本机。

首次提交前，仅需为当前项目配置一次提交身份：

```bash
git config user.name "你的名字"
git config user.email "你的邮箱"
git add .
git commit -m "chore: initialize project"
```

日常开发通常使用下面的流程：

```bash
git status                         # 查看哪些文件发生了变化
git diff                           # 查看尚未暂存的具体修改
git add path/to/file               # 暂存指定文件
git commit -m "feat: describe change" # 保存一个本地版本
git log --oneline --decorate -10   # 查看最近提交
```

开发新功能时，建议单独创建分支：

```bash
git switch -c feature/feature-name
# 修改并提交代码
git switch main
git merge feature/feature-name
```

需要连接 GitHub、GitLab 或其他远程仓库时：

```bash
git remote add origin <远程仓库地址>
git push -u origin main
```

提交前可用 `git status --ignored` 确认 `.env` 和大型参考资料处于忽略状态。不要使用 `git add -f` 强制提交 `.env`。
