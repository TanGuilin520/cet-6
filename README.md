# CET-4 Reading Lab

一个无需前端构建工具的本地英语四级在线试卷平台。项目同时包含试卷上传与自动解析、完整真题阅读器、原有的单篇阅读练习页，以及可选的 LangGraph Agent 辅导与复核运行层；内置演示卷采用 2021 年 6 月四级真题第 1 套，共 8 页。

完整卷以原 PDF 页面图像保持版式，并叠加可选择的文字坐标层和独立标注层。`data/reference/` 保存原始归档资料，`public/assets/papers/` 保存由工具生成、可直接在浏览器加载的试卷资源。

## 1. 功能

- **完整试卷**：原卷 8 页连续展示，支持缩略图、翻页、缩放、适合宽度和原 PDF 下载。
- **统一整卷入口**：首页只展示真实存在的内置卷和解析完成的上传卷；真题、模拟卷与上传卷全部进入同一个 `reader.html`，共享答题、AI、听力、写作模板和标注能力。旧 `practice.html` 仅保留为单篇阅读专项演示。
- **上传即解析**：上传试卷 PDF、可选答案 PDF 和听力音频，由服务器自动生成页面图、文字坐标、题目、答案与检索索引；整卷 JPG 使用一次 Poppler 批量渲染，避免逐页重复启动进程。
- **扫描件适配**：优先读取 PDF 文字层；无文字或混合扫描页可调用独立 PaddleOCR sidecar，并继续保留 OCRmyPDF/Tesseract 回退。上传页会显示当前 OCR 能力。
- **解析复核工作台**：集中处理缺题、低置信度题目和答案冲突，可在原卷页定位 bbox、补题、修正选项与答案，再以带版本和审计记录的原子修订发布。
- **AI 复核建议**：可选 Agent 对当前 issue 和锁定 revision 生成带证据的字段级建议；建议只会进入预览，用户明确应用到表单、核对并填写理由后才能通过原有 ETag 流程保存。
- **在线答题**：在原卷外侧预留独立答题轨道，默认只显示题号和已选答案；点击题号才展开 A/B/C/D，不覆盖 PDF 内容，并支持题号导航、待复查、定位和自动保存。
- **写作模板填空**：写作题可导入 UTF-8 的 TXT/Markdown 模板，把 `{{主题}}`、`{{理由1}}` 等占位符变成填空项，预览后再显式应用到作文。
- **答案与批改**：答案只从上传答案 PDF 的明确标记绑定，不硬编码；冲突或越界答案不会进入客观题批改。
- **按题 Agent 辅导**：先按 Question ID 精确检索答案资料，再用本地向量补充；可选 LangGraph 运行层执行意图路由、只读工具、grounding guard 和 SQLite checkpoint，回答可折叠显示引用与工具轨迹。sidecar 不可用时自动保留原有保守辅导路径。
- **Agent Evals**：内置合成黄金案例，回归意图路由、官方资料优先、禁止写入、证据不足不猜测和字段建议白名单，并输出通过率与 P50/P95 延迟。
- **听力播放**：同源音频流支持播放、暂停、进度、音量、HTTP Range 与 0.75×–2.0× 倍速。
- **点击查词**：在“查词 / 标签”模式单击任意英文单词，立即朗读并显示中文释义；不需要再次 OCR。
- **选段复制**：切换“选段复制”后拖选同一页文字，可在确认面板复制纯文本；浏览器拒绝剪贴板权限时保留手动复制入口。
- **笔直画线**：直线工具只记录起点和终点，拖动时预览，松开后得到一条标准直线。
- **矩形荧光笔**：先自由选择颜色，再拖选英文文字；系统按实际单词边界和行生成规整长方形，每条标注独立保存颜色，不会形成手绘曲线。
- **选段标签**：拖选一段文字，记录重点、长难句、生词、疑问或自定义标签，并附加复习备注。
- **标注管理**：直线、荧光标记和标签按页保存到 `localStorage`，支持橡皮擦和会话内撤回。
- **单篇练习**：`practice.html` 保留单词发音、翻译、生词本、题目解析和 DeepSeek 学习助手等原有演示功能。

## 2. 目录结构

```text
.
├── public/                            # 浏览器可直接访问的静态资源
│   ├── index.html                     # 试卷库首页
│   ├── upload.html                    # 试卷、答案和音频上传页
│   ├── review.html                    # 题目与答案解析复核工作台
│   ├── reader.html                    # 完整真题阅读器
│   ├── practice.html                  # 原单篇阅读练习页
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
│   │   └── practice.js                # 单篇练习逻辑
│   └── assets/
│       ├── papers/2021-06-set-01/     # 8 页图像、文字坐标、题目、答案和原 PDF
│       └── audio/                     # 预置及动态生成的单词音频
├── server/                            # Python 服务端代码
│   ├── __init__.py
│   ├── __main__.py                    # python -m server 入口（需 3.11+）
│   ├── app.py                         # 静态服务、TTS、DeepSeek 代理
│   ├── agent_client.py                # 到 Agent sidecar 的受限适配器（Python 3.11）
│   ├── paddle_ocr.py                  # PaddleOCR sidecar 客户端（Python 3.11）
│   └── platform.py                    # 上传、PDF/OCR、复核、RAG 与资源 API
├── services/agent/                    # Python 3.11 LangGraph Agent runtime
├── services/paddleocr/                # 隔离运行的 PaddleOCR 3.7 服务
├── data/agent/                        # Agent SQLite checkpoint（Git 忽略）
├── data/exams/                        # 上传与生成的运行数据（Git 忽略）
├── data/reference/2021-06/            # 归档的 PDF、MP3 参考资料
│   ├── listening/
│   ├── papers/
│   └── answers/
├── evals/                              # 合成 Agent 黄金案例与使用说明
├── tools/
│   ├── build_exam_assets.py           # PDF 页面图与文字坐标生成工具
│   └── run_agent_evals.py             # Agent 契约、策略与延迟评测
├── .env.example                       # DeepSeek 与可选 sidecar 配置模板
├── docker-compose.agent.yml           # Agent runtime 的本机隔离启动配置
├── docs/agent-architecture.md         # Agent 工作流、运行方式和安全边界
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
.venv-main/bin/python -m pip install -r services/agent/requirements.txt  # 仅 CI/E2E 需要
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
.venv-main/bin/python -m server
```

然后打开：

- 首页：<http://127.0.0.1:4173/>
- 导入试卷：<http://127.0.0.1:4173/upload.html>
- 解析复核：上传完成后点击“复核解析”，或访问 `review.html?exam=<examId>`
- 完整真题：<http://127.0.0.1:4173/reader.html?paper=2021-06-01>
- 原单篇练习：<http://127.0.0.1:4173/practice.html?paper=2025-12-01>

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

保存后重启服务：

```bash
.venv-main/bin/python -m server
```

密钥只由 Python 服务读取；网页源码、浏览器请求头和 `localStorage` 中不保存密钥。`.env` 已被 `.gitignore` 忽略。

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

也可以省略 `model`，由服务器按 `CET_AGENT_DEEPSEEK_MODEL → DEEPSEEK_MODEL → deepseek-v4-flash` 选择默认值。
```

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

Agent 依赖不安装进主服务环境，而是使用独立的 `.venv-agent`（同样是 Python 3.11，依赖隔离）运行：

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r services/agent/requirements.txt

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

重启 `.venv-main/bin/python -m server` 后，`/api/exams/capabilities` 的 `agent.ready` 应为 `true`。未配置 Agent 时系统不会失去已有功能；Reader 回退到原来的本地/DeepSeek 路径，Review 仍可手动完成。完整拓扑与公开契约见 [Agent 架构文档](docs/agent-architecture.md)，Docker 和 sidecar 内部契约见 [Agent runtime 说明](services/agent/README.md)。

## 5. 使用流程

1. 打开“导入试卷”，选择试卷 PDF；答案 PDF、听力音频和试卷名称可以留空。
2. 点击“上传并生成试卷”，等待文字检测、页面生成、结构解析、答案绑定和索引完成。
3. 查看可靠、建议检查、人工确认及未识别数量；有待处理项时先进入“复核解析”。启用 Agent 后可获取字段级建议，但必须人工点击“应用到表单（不会保存）”、对照原卷核查并填写修改理由。
4. 发布复核版本后进入阅读器。点击原卷左侧题号展开或收起 A/B/C/D；选中后，题号旁会直接显示当前答案。也可用右侧题号导航定位、标记待复查；提交后只批改有明确答案绑定的客观题。
5. 点击右下角“问 AI”打开常驻题目助手；切换题号时窗口自动跟随当前题，各题对话互不混用，桌面端可以最小化。
6. 写作题可上传不超过 64KB 的 UTF-8 `.txt`/`.md` 模板。模板需包含 `{{主题}}` 形式的占位符；填完字段并检查实时预览后，点击“应用到作文”。导入或编辑模板不会自动覆盖已有作文。
7. “查词 / 标签”用于点击查词和选段标签；“选段复制”用于复制 PDF 文本；荧光笔旁可自由选择颜色。直线、橡皮擦、撤回与缩放继续按原方式工作。

也可以在首页直接打开内置的“2021 年 6 月四级真题（第 1 套）”。它使用稳定 ID `2021-06-01`，具备与上传卷相同的 47 题 Question Layer、评分、写作模板和 AI 助手；服务器若发现同一 PDF 哈希的 ready 解析记录，会透明复用其最新复核版本与听力音频，但不会改变浏览器存储键。没有实际 PDF 的旧占位模拟卷不再展示。

完整卷的作答、写作模板、标记、分题对话、荧光颜色、标注与单篇练习记录分别保存在当前浏览器的 `localStorage` 中，不会自动同步到其他设备。模板文件只在浏览器本地读取，不会上传服务器，也不会自动发送给 AI；复制面板中的临时文本不会持久化。上传的试卷资料与生成资源保存在服务端本机的 `data/exams/`。

## 6. 接口与资源

| 地址 | 方法 | 作用 |
| --- | --- | --- |
| `/api/exams/upload` | POST | 上传试卷、答案和音频，返回异步任务 |
| `/api/exams` | GET | 最近导入的试卷 |
| `/api/exams/capabilities` | GET | Poppler、PaddleOCR 与本机 OCR 能力 |
| `/api/exams/{id}/status` | GET | 解析阶段、进度、错误与结果地址 |
| `/api/exams/{id}/manifest` | GET | 页面图和透明文字坐标 |
| `/api/exams/{id}/questions` | GET | 题目、结构、置信度与未识别项；返回复核 ETag |
| `/api/exams/{id}/answers` | GET | 明确答案、解析和冲突项；可用 `If-Match` 锁定同一复核版本 |
| `/api/exams/{id}/review` | GET/PATCH | 读取复核数据；按 ETag 原子发布修订 |
| `/api/exams/{id}/audio` | GET/HEAD | 支持 Range 的听力音频 |
| `/api/papers/2021-06-01/manifest` | GET | 内置卷页面资源与显式 `audioUrl` 能力；无听力时为 `null` |
| `/api/papers/2021-06-01/questions` | GET | 内置卷题目；按 PDF SHA 复用同卷最新只读解析，缺失时回退静态题目 |
| `/api/papers/2021-06-01/answers` | GET | 内置卷答案与同版本 ETag；不开放复核写入 |
| `/api/papers/2021-06-01/audio` | GET/HEAD | 同 SHA ready 卷存在听力时提供音频，否则明确返回 404 |
| `/api/papers/2021-06-01/assistant` | POST | 内置卷按题 AI；复用 Agent、DeepSeek 和保守无编造回退 |
| `/api/exams/{id}/assistant` | POST | 题号精确检索优先的本题助手；可选返回 Agent 引用与工具轨迹 |
| `/api/exams/{id}/agent/review-suggestions` | POST | 为当前 issue/revision 生成只读字段建议，不保存复核 |
| `/api/tts?word=WORD` | GET/HEAD | 生成或读取英文单词 WAV |
| `/api/deepseek` | POST | DeepSeek 对话代理 |
| `/api/chat` | POST | DeepSeek 对话代理兼容路径 |

预置音频位于 `public/assets/audio/`；动态音频缓存位于 `public/assets/audio/cache/`，删除后会在下次请求时重新生成。

完整卷的中文释义在浏览器中调用 MyMemory 公共英中翻译接口，并使用会话内缓存；接口不可用时，词卡仍可继续朗读。

## 7. 常见问题

### 点击单词没有声音

确认页面由 Python 3.11 的 `.venv-main/bin/python -m server` 提供，检查浏览器标签页的静音状态和系统音量。预置词使用 `public/assets/audio/*.wav`；其他词需要本机安装 `flite`，否则会使用浏览器语音合成。

### AI 助手提示未配置

确认 `.env` 位于项目根目录、`DEEPSEEK_API_KEY` 已填写，并重启 `.venv-main/bin/python -m server`。同时确认网络和 DeepSeek 账户额度可用。

配置后，本题题干、用户问题和检索到的答案资料会发送给 DeepSeek；不要在未披露该数据边界的情况下把服务直接提供给第三方用户。未配置时使用本地保守回答，不会猜测缺失解析。

### AI 复核建议不可用

先访问 `/api/exams/capabilities` 检查 `agent`：`configured=false` 表示主服务没有配置 `CET_AGENT_URL`；`reachable=false` 表示 sidecar 未启动、Token 不一致或网络不可达；`ready=false` 通常表示 Python 版本、LangGraph 依赖或 checkpoint 目录有问题。建议接口失败不会自动改动表单或 revision，可以继续人工复核。

### 扫描版 PDF 解析失败

上传页会先显示服务器是否具备扫描卷能力。可以按 [PaddleOCR sidecar 说明](services/paddleocr/README.md) 启动 PaddleOCR，也可以安装 OCRmyPDF，或同时安装 Tesseract 与 Poppler。答案 PDF 含中文时建议启用 Paddle 中文模型或 Tesseract `chi_sim`。纯扫描卷缺少 OCR 能力时任务会明确失败；混合 PDF 会保留原生文字页，并在 manifest 中列出仍需人工检查的页面。

### 标注或答题状态消失

状态保存在浏览器 `localStorage`。无痕窗口、清理站点数据、更换浏览器或更换设备都会使用新的存储空间。

### 写作模板无法导入

模板只支持 1B–64KB 的 UTF-8 `.txt` 或 `.md` 文件，正文不能超过 12,000 个字符，并且至少包含一个 `{{名称}}` 占位符。二进制内容、NUL 字符或错误编码会被拒绝；模板替换后的作文也不能超过 12,000 个字符。

### 重新生成完整试卷资源

需要本机安装 Poppler 的 `pdftotext` 和 `pdftoppm`，然后执行：

```bash
python3 tools/build_exam_assets.py \
  "data/reference/2021-06/papers/2021.06四级真题第1套.pdf" \
  "public/assets/papers/2021-06-set-01" \
  --id "2021-06-01" \
  --title "2021年6月大学英语四级真题（第1套）"
```

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
python3 -m py_compile server/app.py server/platform.py server/agent_client.py server/paddle_ocr.py server/__main__.py services/agent/app.py services/paddleocr/app.py tools/build_exam_assets.py
python3 -m unittest discover -s tests -v
python3 tools/run_agent_evals.py --validate-only
```

修改页面结构或工具栏后，建议在桌面和手机宽度各打开一次完整卷，回归检查 8 页加载、题号轨道展开与不遮卷、选段复制及权限降级、不同颜色荧光刷新恢复、直线、标签、橡皮擦、撤回、AI 开窗切题与写作模板导入/预览/覆盖保护；单篇练习功能在 `practice.html` 单独检查。

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
