# CET-4 Reading Lab

一个无需前端构建工具的本地英语四级在线试卷平台。项目同时包含试卷上传与自动解析、完整真题阅读器和原有的单篇阅读练习页；内置演示卷采用 2021 年 6 月四级真题第 1 套，共 8 页。

完整卷以原 PDF 页面图像保持版式，并叠加可选择的文字坐标层和独立标注层。`data/reference/` 保存原始归档资料，`public/assets/papers/` 保存由工具生成、可直接在浏览器加载的试卷资源。

## 1. 功能

- **完整试卷**：原卷 8 页连续展示，支持缩略图、翻页、缩放、适合宽度和原 PDF 下载。
- **上传即解析**：上传试卷 PDF、可选答案 PDF 和听力音频，由服务器自动生成页面图、文字坐标、题目、答案与检索索引。
- **扫描件适配**：优先读取 PDF 文字层；没有文字层时自动尝试 OCRmyPDF 或 Tesseract，并明确报告缺少的 OCR 依赖。
- **在线答题**：在原卷外侧预留独立答题轨道，默认只显示题号和已选答案；点击题号才展开 A/B/C/D，不覆盖 PDF 内容，并支持题号导航、待复查、定位和自动保存。
- **写作模板填空**：写作题可导入 UTF-8 的 TXT/Markdown 模板，把 `{{主题}}`、`{{理由1}}` 等占位符变成填空项，预览后再显式应用到作文。
- **答案与批改**：答案只从上传答案 PDF 的明确标记绑定，不硬编码；冲突或越界答案不会进入客观题批改。
- **按题辅导**：先按 Question ID 精确检索答案资料，再用本地向量补充；桌面端使用可最小化的常驻悬浮窗，切题时同步题目并隔离每题历史；没有官方解析时固定显示 AI 辅助分析声明。
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
│   ├── reader.html                    # 完整真题阅读器
│   ├── practice.html                  # 原单篇阅读练习页
│   ├── css/
│   │   ├── home.css
│   │   ├── upload.css
│   │   ├── reader.css                 # 完整卷阅读器样式
│   │   └── practice.css               # 单篇练习样式
│   ├── js/
│   │   ├── home.js
│   │   ├── upload.js                  # 上传、状态轮询和最近试卷
│   │   ├── reader.js                  # 完整卷分页与标注逻辑
│   │   └── practice.js                # 单篇练习逻辑
│   └── assets/
│       ├── papers/2021-06-set-01/     # 8 页图像、文字坐标和原 PDF
│       └── audio/                     # 预置及动态生成的单词音频
├── server/                            # Python 服务端代码
│   ├── __init__.py
│   ├── __main__.py                    # python3 -m server 入口
│   ├── app.py                         # 静态服务、TTS、DeepSeek 代理
│   └── platform.py                    # 上传、PDF/OCR、题目/答案、RAG 与资源 API
├── data/exams/                        # 上传与生成的运行数据（Git 忽略）
├── data/reference/2021-06/            # 归档的 PDF、MP3 参考资料
│   ├── listening/
│   ├── papers/
│   └── answers/
├── tools/
│   ├── build_exam_assets.py           # PDF 页面图与文字坐标生成工具
│   └── codex-instruct-v0.1.3.py       # 独立辅助工具，与网页运行无关
├── .env.example                       # DeepSeek 配置模板
├── docs/platform-architecture.md      # 平台流程、数据与技术边界
├── tests/test_platform.py             # 解析与“禁止猜测”回归测试
├── .gitignore
└── README.md
```

根目录只保留项目级配置、说明和一级功能目录。`__pycache__/`、`.env` 和 `public/assets/audio/cache/` 属于运行产物或本地配置，已加入忽略规则。

## 3. 启动项目

### 前置条件

- Python 3.8–3.12（当前上传解析使用该版本范围内的标准库 multipart 支持）
- 现代浏览器
- Python 服务本身使用标准库，不需要安装 Python 第三方包
- 上传解析需要 Poppler：`pdftotext` 与 `pdftoppm`
- 扫描版 PDF 需要 OCRmyPDF，或 Tesseract + Poppler；中文答案建议安装 `chi_sim`
- `flite` 是可选依赖：安装后可为未预置的英文单词生成 WAV；未安装时网页会尝试浏览器语音

### 启动

在项目根目录执行：

```bash
python3 -m server
```

然后打开：

- 首页：<http://127.0.0.1:4173/>
- 导入试卷：<http://127.0.0.1:4173/upload.html>
- 完整真题：<http://127.0.0.1:4173/reader.html?paper=2021-06-01>
- 原单篇练习：<http://127.0.0.1:4173/practice.html?paper=2025-12-01>

TTS 和 DeepSeek 都依赖 Python 服务，直接在 `public/` 中运行静态文件服务器时不会提供这些接口。

端口被占用时：

```bash
python3 -m server --port 4174
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
DEEPSEEK_MODEL=deepseek-chat
```

保存后重启服务：

```bash
python3 -m server
```

密钥只由 Python 服务读取；网页源码、浏览器请求头和 `localStorage` 中不保存密钥。`.env` 已被 `.gitignore` 忽略。

也可以使用环境变量：

```bash
DEEPSEEK_API_KEY='你的真实密钥' DEEPSEEK_MODEL='deepseek-chat' python3 -m server
```

### DeepSeek 接口

网页调用同源接口：

```http
POST /api/deepseek
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    {"role": "user", "content": "请解释 flexible 在本文中的含义。"}
  ]
}
```

成功响应：

```json
{"reply":"……"}
```

服务端固定请求 DeepSeek 官方 Chat Completions 地址，并限制请求体大小、消息数量、单条文本长度和消息角色。也兼容 `POST /api/chat`。

## 5. 使用流程

1. 打开“导入试卷”，选择试卷 PDF；答案 PDF、听力音频和试卷名称可以留空。
2. 点击“上传并生成试卷”，等待文字检测、页面生成、结构解析、答案绑定和索引完成。
3. 查看可靠、建议检查、人工确认及未识别数量；完成后进入阅读器。
4. 点击原卷左侧题号展开或收起 A/B/C/D；选中后，题号旁会直接显示当前答案。也可用右侧题号导航定位、标记待复查；提交后只批改有明确答案绑定的客观题。
5. 点击右下角“问 AI”打开常驻题目助手；切换题号时窗口自动跟随当前题，各题对话互不混用，桌面端可以最小化。
6. 写作题可上传不超过 64KB 的 UTF-8 `.txt`/`.md` 模板。模板需包含 `{{主题}}` 形式的占位符；填完字段并检查实时预览后，点击“应用到作文”。导入或编辑模板不会自动覆盖已有作文。
7. “查词 / 标签”用于点击查词和选段标签；“选段复制”用于复制 PDF 文本；荧光笔旁可自由选择颜色。直线、橡皮擦、撤回与缩放继续按原方式工作。

也可以在首页直接打开内置的“2021 年 6 月四级真题（第 1 套）”，回归原有 8 页阅读与标注功能。

完整卷的作答、写作模板、标记、分题对话、荧光颜色、标注与单篇练习记录分别保存在当前浏览器的 `localStorage` 中，不会自动同步到其他设备。模板文件只在浏览器本地读取，不会上传服务器，也不会自动发送给 AI；复制面板中的临时文本不会持久化。上传的试卷资料与生成资源保存在服务端本机的 `data/exams/`。

## 6. 接口与资源

| 地址 | 方法 | 作用 |
| --- | --- | --- |
| `/api/exams/upload` | POST | 上传试卷、答案和音频，返回异步任务 |
| `/api/exams` | GET | 最近导入的试卷 |
| `/api/exams/{id}/status` | GET | 解析阶段、进度、错误与结果地址 |
| `/api/exams/{id}/manifest` | GET | 页面图和透明文字坐标 |
| `/api/exams/{id}/questions` | GET | 题目、结构、置信度与未识别项 |
| `/api/exams/{id}/answers` | GET | 明确答案、解析和冲突项 |
| `/api/exams/{id}/audio` | GET/HEAD | 支持 Range 的听力音频 |
| `/api/exams/{id}/assistant` | POST | 题号精确检索优先的本题助手 |
| `/api/tts?word=WORD` | GET/HEAD | 生成或读取英文单词 WAV |
| `/api/deepseek` | POST | DeepSeek 对话代理 |
| `/api/chat` | POST | DeepSeek 对话代理兼容路径 |

预置音频位于 `public/assets/audio/`；动态音频缓存位于 `public/assets/audio/cache/`，删除后会在下次请求时重新生成。

完整卷的中文释义在浏览器中调用 MyMemory 公共英中翻译接口，并使用会话内缓存；接口不可用时，词卡仍可继续朗读。

## 7. 常见问题

### 点击单词没有声音

确认页面由 `python3 -m server` 提供，检查浏览器标签页的静音状态和系统音量。预置词使用 `public/assets/audio/*.wav`；其他词需要本机安装 `flite`，否则会使用浏览器语音合成。

### AI 助手提示未配置

确认 `.env` 位于项目根目录、`DEEPSEEK_API_KEY` 已填写，并重启 `python3 -m server`。同时确认网络和 DeepSeek 账户额度可用。

配置后，本题题干、用户问题和检索到的答案资料会发送给 DeepSeek；不要在未披露该数据边界的情况下把服务直接提供给第三方用户。未配置时使用本地保守回答，不会猜测缺失解析。

### 扫描版 PDF 解析失败

确认安装 OCRmyPDF，或同时安装 Tesseract 与 Poppler。答案 PDF 含中文时建议安装 Tesseract `chi_sim`；也可在 `.env` 中设置 `CET_OCR_LANGUAGES=eng+chi_sim`。依赖缺失时任务会明确失败，不会伪装成解析成功。

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
node --check public/js/reader.js
python3 -m py_compile server/app.py server/platform.py server/__main__.py tools/build_exam_assets.py
python3 -m unittest discover -s tests -v
```

修改页面结构或工具栏后，建议在桌面和手机宽度各打开一次完整卷，回归检查 8 页加载、题号轨道展开与不遮卷、选段复制及权限降级、不同颜色荧光刷新恢复、直线、标签、橡皮擦、撤回、AI 开窗切题与写作模板导入/预览/覆盖保护；单篇练习功能在 `practice.html` 单独检查。

完整 Pipeline、数据格式、RAG 顺序与安全边界见 [平台架构说明](docs/platform-architecture.md)。

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
