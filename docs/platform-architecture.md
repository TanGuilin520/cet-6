# CET 在线试卷平台：实现流程与技术说明

本文说明当前增量实现。系统没有重写阅读器，仍以 PDF 原卷页面为视觉真源，并在原有四层之上增加题目交互层。

## 1. 浏览器分层

```text
Question Interactive Layer  题号定位、选项、当前题状态
HTML Badge Layer            标签按钮
Transparent Text Layer      单词点击、原生选区、矩形荧光
SVG Annotation Layer        直线、高亮、标签轮廓、橡皮擦
PDF Page Image              原卷 JPG，保持印刷版式
```

所有层使用相同的 PDF point 坐标。缩放只改变页面容器的显示比例，因此文字框、标注和题目 bbox 不需要改写。Question Layer 本身不接收鼠标事件，只有题号和选项按钮接收事件，避免破坏既有文字选择与画线逻辑。

题目控件不再放进题目 bbox：阅读器在每页左侧预留 `QUESTION_RAIL_WIDTH=152` 的逻辑坐标轨道，PDF surface 整体右移，轨道与页面按同一比例缩放。折叠时仅显示题号和已选答案，点击题号才展开选项，因此不会遮挡原卷文字；无题页也保留相同轨道，使整卷页面边缘对齐。

“选段复制”复用透明文字层的原生 `Range` 与 word 坐标，只接受单页选区并限制为 20,000 字符。复制先尝试 Clipboard API，权限不可用时回退到兼容复制，仍失败则保留只读文本供用户手动复制。荧光标注在原 annotation 中增加独立 `color` 字段；旧记录没有颜色时使用 `#f6d64a`，不会修改旧数据结构。

## 2. 上传与异步任务

入口为 `/upload.html`。表单使用 `multipart/form-data`，字段如下：

| 字段 | 必填 | 内容 |
| --- | --- | --- |
| `exam_pdf` | 是 | 试卷 PDF |
| `answer_pdf` | 否 | 答案与解析 PDF |
| `audio` | 否 | MP3、WAV 或 M4A |
| `title` | 否 | 留空时取试卷文件名 |

浏览器用 XHR 展示真实字节上传进度。服务器完整接收 multipart 后校验扩展名、文件签名与大小，再安全写入 `data/exams/<examId>/input/`；文件落盘后返回 `202` 和状态地址，随后由有界线程池执行 PDF/OCR 解析，前端继续轮询阶段进度。

每个任务采用原子 JSON 替换写入状态。服务重启时，遗留的 `queued/processing` 任务会被标记为中断，不会永久显示为处理中。

## 3. PDF/OCR Pipeline

```text
PDF 签名与页数校验
        ↓
pdftotext -bbox-layout
        ↓
逐页文字是否足够？ ── 是 ──→ 使用原生文字坐标
        │
        否
        ↓
PaddleOCR sidecar（若配置）
        │ 无/不可用
OCRmyPDF（若安装）
        │ 无
Tesseract TSV + pdftoppm（若安装）
        ↓
统一 page/word PDF 坐标
        ↓
pdftoppm 生成 144 DPI JPG
        ↓
manifest.json
```

- Poppler 的 `pdftotext -bbox-layout` 提供单词及矩形坐标。
- `pdftoppm` 一次批量生成整卷页面图，避免逐页重复打开 PDF；坐标仍使用 PDF point，不使用 JPG 像素。
- PaddleOCR 在独立 Python 3.10/3.11 sidecar 中运行。主服务只发送共享根目录下的相对页面图路径，严格校验返回页集合、图像尺寸、有限坐标和置信度，再把像素框映射回原 PDF point。
- 混合 PDF 保留有文字页的原生坐标，只对文字稀疏页调用 PaddleOCR；sidecar 失败时不覆盖已有文字，并继续尝试原有 OCR 回退。
- OCRmyPDF 可把扫描件转换成带文字层 PDF，再回到同一坐标提取路径。这里刻意关闭旋转和 deskew：阅读器渲染的是原始 PDF，OCR 坐标必须与原图保持同一几何空间。
- Tesseract 兜底读取 TSV 像素框，并按页面宽高换算为 PDF point。
- OCR 语言默认自动检测：同时有 `eng` 和 `chi_sim` 时使用 `eng+chi_sim`；也可用 `CET_OCR_LANGUAGES` 显式配置。
- 纯扫描件在没有可用 OCR 引擎时会明确失败并说明依赖。混合 PDF 会保留已有文字页，并在 manifest 中列出仍无足够文字的页面，避免把空白页或 OCR 失败静默伪装成已识别。

`manifest.json` 与旧阅读器格式兼容：

```json
{
  "id": "exam-...",
  "pageCount": 8,
  "source": "/api/exams/.../source",
  "pages": [
    {
      "number": 1,
      "width": 595.276,
      "height": 841.89,
      "image": "/api/exams/.../assets/pages/page-1.jpg",
      "textSource": "pdf_text",
      "words": [{"text": "example", "x": 10, "y": 20, "width": 30, "height": 9}]
    }
  ],
  "extraction": {
    "engine": "pdf_text+paddleocr",
    "unresolvedTextPages": [],
    "ocrNotice": null
  }
}
```

每页 `textSource` 记录 `pdf_text`、`paddleocr`、`ocrmypdf` 或 `tesseract`。结构化解析按实际页面来源计算置信度，不会因为同卷另一页使用 OCR 而整体降低原生文字页的可信度。

## 4. 题目结构化

当前可运行版本使用“坐标证据优先”的结构化解析器：结合题号、同一水平行、Section/Directions、A–D 选项和双栏布局生成 `questions.json`。它不依赖开发者提前运行脚本。

双栏 PDF 常把 `40.` 与右侧题干输出为两个 XML line。解析器只在“同页、同一 y、短水平间隔”同时成立时合并。Section B 段落匹配会依据 Directions 中明确出现的 paragraph/letter 规则生成 A–O 范围内的可选标签。缺失选项文字时只补空的 A–D 控件，并把置信度降到人工确认区间，绝不补写选项内容。

置信度规则：

| 分数 | 状态 | 行为 |
| --- | --- | --- |
| `0.95–1.0` | 可靠 | 正常显示 |
| `0.80–0.95` | 建议检查 | 显示复核标记 |
| `<0.80` | 人工确认 | 显示低置信度，内容不被伪装成可靠结果 |

相邻已识别题号之间的缺口写入 `questions.json.unresolved`。系统报告题号和原因，但不生成虚假题干，也不把它加入自动批改。

当前结构解析器是可审计的 MVP，不是视觉大模型。后续接入视觉模型时，应保留现有验证层：模型候选必须能回指页面、文字或图像证据，且上传者应明确同意把试卷内容发送给外部服务。

### 解析复核与发布

`review.html?exam=<examId>` 聚合缺失题号、低置信度题目、答案冲突和待确认项。编辑器显示原卷页与 bbox，允许补题、修改题目/选项、绑定答案或移除错误记录。

复核写入使用 `PATCH /api/exams/{id}/review`。客户端同时提交 `If-Match: "review-rN"` 和 `baseRevision`，服务端完成字段白名单、题号唯一性、页面/bbox 边界、选项与答案交叉验证后，先生成不可变 revision 快照和审计哈希，再原子切换 `review/current.json`。并发版本变化返回冲突，不能静默覆盖。指针读取时会重新校验快照 schema 与文件哈希；若上次进程在指针切换前留下孤立 revision，后续发布会跳过该编号，不会永久卡住。

`/questions` 和 `/answers` 的响应均携带同一形式的 revision ETag。Reader 先取得题目版本，再用 `If-Match` 读取答案；版本在两次请求之间发生变化时，服务返回前置条件失败，页面重新加载而不会拿旧题配新答案评分。AI 请求同样携带 `reviewRevision`，服务端在一个锁定快照中读取题目、答案与 RAG。复核发布后，`status.json.result.reviewCounts` 与版本号也同步更新，因此上传历史不会继续显示旧的待复核数量。

## 5. 答案解析与批改

答案只接受以下明确证据：

- `26: C`、`26. C` 一类题号与答案标记；
- 明确的题号范围与连续字母；
- 答案册中“题号行之后的唯一答案标签”。

答案册常采用双栏排版。服务端先按全宽分隔行切 band，再按“左栏从上到下、右栏从上到下”恢复阅读顺序，避免答案整体错位。若同题出现冲突字母，或答案字母不在已识别选项中，该项进入 `conflicts`，不会进入批改键。

浏览器只批改有明确答案绑定的客观题，统计答对、已答、可评分及缺少可评分答案的数量。作文和翻译文本继续保存在当前试卷专属的 `localStorage`，当前阶段不做 AI 主观评分。

写作模板同样是浏览器本地能力，只在 `question.type` 为 writing 时显示。它接受 1B–64KB 的 UTF-8 TXT/Markdown，正文上限 12,000 字符，最多解析 40 个唯一占位符，每个填空值上限 1,000 字符。模板元数据存入 `writingTemplates[questionId]`；用户明确应用后，生成的纯文本仍写入原有 `answers[questionId]` 字符串，因此无需改变 Questions、Answers 或提交接口。已有作文在覆盖前必须确认，超过答案长度上限则拒绝应用。

## 6. RAG 与 AI 辅导

答案 PDF 的可用文本和明确答案被切分后写入每套试卷自己的 SQLite：

```text
questionId 精确查询
        +
本地确定性哈希向量余弦检索
        ↓
证据包
        ↓
DeepSeek（配置密钥时）或本地保守回答
```

题号精确检索永远优先；向量结果只能补充背景，不能覆盖当前题答案。人工改正或移除答案时，同题旧的原始答案片段会从新 revision 的检索库中清除，避免旧答案与新答案同时进入提示词；证据来源会区分上传答案 PDF 与人工核对。这里的本地哈希向量是零依赖检索基线，不等同于生产级语义 Embedding 服务。

若当前题没有答案 PDF 官方解析，响应固定携带：

> 答案资料中没有找到官方解析，以下为 AI 辅助分析。

没有配置 DeepSeek 时，服务仍返回题号、用户答案、明确答案和免责声明，但不会推断“其他选项为什么错误”。配置 DeepSeek 后，题目、用户问题以及检索到的答案资料会发送给 DeepSeek；部署者需要在隐私说明中披露这一点。

每道题的对话历史按 `examId + questionId` 保存在浏览器，并额外记录 `reviewRevision`；同时限制题数、消息数和长度，避免耗尽 `localStorage`。人工复核发布新版本后，旧版本题解会被清除，不能作为新版答案的后续上下文。

桌面端 AI 使用无 backdrop 的固定悬浮窗，可在继续答题时保持打开或最小化；移动端改为带遮罩的全屏面板。切题时保存并恢复对应问题草稿，发送请求前固定捕获 `aiPanelQuestionId`，pending 和响应也按原题号回写，避免慢请求串入另一题。后端契约是在原 `{questionId,message,userAnswer?,history}` 上增加可选 `reviewRevision`；旧客户端仍可请求，新 Reader 用它阻止跨修订解释。当前 `userAnswer` 仍只附带前 100 个字符，因此本阶段不宣称 AI 能读取整篇作文。

## 7. 听力

上传音频保存在试卷私有运行目录，通过同源 API 流式读取。接口支持 HTTP `Range`，所以浏览器可以拖动进度条而不必先下载完整音频。阅读器使用原生音频控件提供播放、暂停、进度与音量，并增加 0.75×–2.0× 倍速。

ASR、时间戳和题目音频片段尚未实现，数据模型与独立音频路由允许后续增量增加。

## 8. 数据与安全边界

当前运行数据布局：

```text
data/exams/<examId>/
├── input/             原始试卷、答案、听力
├── assets/pages/      生成的 JPG
├── manifest.json
├── questions.json
├── answers.json
├── rag.sqlite3
├── review/
│   ├── current.json       当前原子 revision 指针
│   └── revisions/        不可变 questions/answers/RAG/audit 快照
├── metadata.json
└── status.json
```

- `data/exams/` 已加入 `.gitignore`。
- 上传文件不放入 `public/`，只能通过严格 examId/文件名路由读取。
- POST/PATCH 接口拒绝跨源浏览器请求；当前复核 PATCH 还限制为本机 loopback，并要求 ETag 前置条件。loopback 只是本地开发保护，不是公网反向代理后的鉴权；对外部署前仍必须增加真实身份认证和授权。请求体、文件大小、页数、消息数和文本长度都有上限。
- 文件路由防目录穿越，并提供 `nosniff`；音频支持单段 Range。
- API 密钥仅由服务端环境读取，不进入 HTML、JavaScript 或 `localStorage`。
- 写作模板文件只在浏览器用严格 UTF-8 解码器读取，拒绝 NUL、错误后缀和超限内容；预览只写入 `textContent`/表单 `value`，不解析 HTML，也不上传服务器或自动发送给 AI。
- 这是本地单用户阶段，尚无登录和租户隔离；暴露到公网前必须增加鉴权、配额、病毒扫描、任务队列和对象存储。

## 9. 后续演进

下一阶段可在不改变阅读器五层结构的前提下增加：

1. 明确授权的视觉模型结构解析，并用当前规则和复核工作台做证据校验；
2. 真实语义 Embedding 与向量数据库；
3. ASR、音频时间戳和题目片段；
4. Users、Exams、Questions、UserAnswers、Annotations、AI Conversations 云端表；
5. 登录、权限、云同步与持久后台任务基础设施。
