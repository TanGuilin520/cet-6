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

题目控件不再放进题目 bbox：阅读器在每页左侧预留 `QUESTION_RAIL_WIDTH=152` 的逻辑坐标轨道，并在右侧预留等宽空间，使原卷 surface 的视觉中心对齐阅读区域中心。轨道与页面按同一比例缩放。折叠时仅显示题号和已选答案，点击题号才展开选项，因此不会遮挡原卷文字；无题页也保留相同轨道，使整卷页面边缘对齐。缩放、适宽及侧栏变化后按实际 scrollWidth 横向居中；纵向以可视页内位置为锚点，关闭浏览器自动 scroll anchoring，避免两个机制互相干扰。普通手动横向拖动不被锁死。

“选段复制”复用透明文字层的原生 `Range` 与 word 坐标，只接受单页选区并限制为 20,000 字符。复制先尝试 Clipboard API，权限不可用时回退到兼容复制，仍失败则保留只读文本供用户手动复制。荧光标注在原 annotation 中增加独立 `color` 字段；旧记录没有颜色时使用 `#f6d64a`，不会修改旧数据结构。

### 统一试卷目录与用户自带资料

首页以 `reader.html` 为唯一整卷入口，只显示 `GET /api/exams` 返回的合法 ready 上传记录。没有上传时显示上传引导；读取失败时显示重试，不回退内置卷。相同 PDF 的不同上传记录按各自 exam ID 保留，不按 SHA 隐藏。试卷必选，答案和音频可选；详情只展示实际能力，不固定题数、页数或考试时长。

阅读器没有默认 paper ID，缺失或非法参数跳转上传页；所有资源使用 `/api/exams/{id}/...`。历史 `/api/papers/*`、`/assets/papers/*` 与 `/practice.html` 在 GET/HEAD 或相关 POST 中默认禁止访问。文件和内部兼容函数保留用于回归，不删除用户资料；`CET_ENABLE_DEMO_PAPERS=1` 只可显式启用旧服务资源，不会恢复首页演示卡片。HTTP 静态目录检查统一做 URL 解码和路径标准化。

当前已有写作模板与本题草稿隔离、选段笔记、翻译对照、显式预览应用、个人表达库、跨试卷查找／重练／导出，以及固定 GitHub 学习资料导入和方法 RAG、授权的个人笔记辅导。已实现与后续边界见 [产品方案](learning-methods-product-plan.md)；任意仓库导入、逐卡修订、原文选区／方法／错因完整双向关系、听力时间点笔记、云同步与多用户隔离仍未实现。

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
- PaddleOCR 在独立 Python 3.11 sidecar（`.venv-paddleocr` 或 Docker）中运行。主服务只发送共享根目录下的相对页面图路径，严格校验返回页集合、图像尺寸、有限坐标和置信度，再把像素框映射回原 PDF point。
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

个人作文模板库入口为 `writing.html`，由 `writing-templates.js` 提供零网络、本地存储的 `list/get/save/remove/parse/compile`。正式库使用 `cet:writing-template-library:v1`，最多 30 份模板；编辑草稿使用独立的 `cet:writing-template-draft:v1`，切换模板时分别保留。没有登录账户或云同步，同一浏览器配置文件共享本地库。源正文上限 12,000 字符，最多 40 个唯一占位符，同名占位共用值，名称最多 80 字符且不能换行，每个填空值上限 1,000 字符；区分单词输入和多行句子输入。纯文本导入用严格 UTF-8 解码，拒绝 NUL 和超限文件，导入只创建草稿；无占位正文可以保存为固定段落。导出原模板 MD 保留占位符，导出成稿 TXT 保存当前填入内容。

作文工作台桌面采用左侧模板库、中间原题与作文编辑、右侧填空与实时成稿的布局，小屏顺序展示。`writing-task.js` 只读同源试卷题目与 manifest：带真实题号时先验证该题存在且类型为 writing，再展示对应题干；题干不足时可从该题所在页的明确 Writing 标题及文字坐标恢复，题号绑定的有效 bbox 可作有限回退。仅有页码的链接必须有明确、唯一的 Writing 标题，不会猜题号或借用其他题干。显示层只使用 `textContent`，不读取答案 PDF、调用 AI 或写入模板／作答；读取失败、OCR 不足或定位不明时明确提示返回原卷。确认的上下文通过 `writing-task-loaded` 事件及只读 `WritingTaskContext` 提供给编辑器。

`writing.js` 默认按开头、主体、结尾三段编辑，空行是明确段落边界，不根据句子数凭空拆段；已有超过三段的模板进入完整正文模式，切换时拒绝静默合并。三段编辑只是同一模板正文的视图，正式库与草稿仍保留原有 `source` 字符串和 `slots` 格式，不迁移或清空旧数据；合并正文继续受总计 12,000 字符限制。填空工具针对当前活动段落，预览与导出沿用安全的模板编译逻辑。每段及总词数是辅助估算，只有原题明确给出且不存在冲突的字数区间才提示范围，不默认套用 CET-4／CET-6 字数，也不宣称自动评分。

工作台区分“本题作答”和“我的模板”：`cet:writing-answers:v1` 独立保存最多 200 个试卷＋真实题号／页码上下文草稿，不回写复用模板。复制模板到本题需确认替换已有正文，另存模板是独立操作；恢复及切换保留 `source`／`slots`。本题草稿以当前存储基线检查同上下文跨窗口修改，冲突时保留输入、暂停自动覆盖并提供重新载入；没有可确认的真实题号仍可练习和保存页级草稿，但不能应用。作文提供专注模式及小屏编辑／模板／预览切换。

写作题的填空工作区只在 `question.type` 为 writing 时显示，允许使用库模板或直接导入 1B–64KB TXT/Markdown。库模板复制到本题的 `writingTemplates[questionId]`，本题改动不回写库，支持明确“另存”为新模板；旧文件直接导入仍要求有占位符。切换本题已有模板前确认，实际答案只在用户点击“应用到作文”后写入原有 `answers[questionId]` 字符串，因此不改变 Questions、Answers 或提交接口。已有作文在覆盖前必须确认，缺少填空或成稿超过 12,000 字符则拒绝应用。跨页、另一标签页或返回缓存页面时只更新库选择器，避免替换正在编辑的答案。

作文、翻译入口分别沿对应题型位置显示在原卷左侧，右侧作答区和顶部也有入口。翻译题的蓝色 `.page-question-number` 本身使用本地工作台链接，点击直接跳转，不先展开作答区；其他题号保持原有交互。`.page-module-entry-layer` 保留原卷坐标原点，不改变图片、文字坐标或 SVG 标注；优先采用对应题型的有效 bbox.y。无可用题目坐标时，只识别明确独立的 Writing／Translation（含 Part、时间）标题，普通正文中的单词不会生成入口；无法确定位置时仅保留全局入口，不猜页码或题号。移除此前每页重复的页顶操作条与 52px 空白。模块链接与题号列分开，逆缩放字号与触控高度、按轨道宽度简写按钮，原卷仍使用两侧对称轨道居中。跳转只带安全的 `paper`、可选 `question` 和 `page` 参数，不传作答正文。工作台返回链接只允许本地阅读器和合法参数；阅读器再次验证题号实际存在后优先定位题目，否则恢复存在的原页。跳转前立即保存作答和笔记草稿，失败时留在当前页；普通保存模板／笔记不提交作答，只有单独确认应用才写本题答案。

翻译工作台继续使用原生 HTML/CSS/JS，桌面采用左侧方法目录、中间对照练习、右侧方法原文与例句，小屏切换练习／方法／资料并保留保存和应用入口。`translation.js` 从同源题目和 manifest 读取当前翻译原文；优先使用与真实题号绑定的中文内容，缺题号时只能依据明确 Translation 标题及页面坐标恢复可确认的段落，不把英文 Directions 或答案解析当原文。仅在没有恢复笔记／草稿且用户尚未编辑时，填入空白原文；绑定题号的当前浏览器作答可复制为初译。手动“重新载入原题”只更新原句，有内容时确认。保存笔记不写 `answers`；显式“应用到本题”可选择初译／修改稿（修改稿为空回退初译），展示成稿及旧答案，确认覆盖后再验证真实题号、translation 类型及题目版本，合并保存本题并返回。

`cet:translation-method:v1` 保存一份可跨卷使用的个人方法正文；严格 UTF-8 TXT/MD 导入不超过 64KB、24,000 字符，只更新编辑草稿。`cet:translation-notes:v1` 保存最多 200 份按试卷＋题号（无题号时按页码）隔离的对照笔记，六个字段均可选、各不超过 12,000 字符；无试卷时使用独立个人笔记。增量 `methodRefs` 最多 32 项，每项 `{source: github|personal,id,title}`，保持来源和 ID 区分，不靠相同名称混合记录；旧笔记无该字段仍可读。`cet:translation-note-drafts:v1` 独立保留方法及当前上下文草稿，180ms 防抖与离页刷新；写入时合并最新记录，避免覆盖另一题的草稿。损坏的数据拒绝覆盖，存储失败保留输入并显示实际失败。这些浏览器个人数据不会被 GitHub 目录覆盖，也不替代现有选区 SVG 笔记。

### 本地表达、作答应用与学习记录

`learning-store.js` 提供共用的严格校验、本地读写及安全 DOM 表达组件。`cet:expression-library:v1` 最多 500 条，每条保存表达、用途分类、最多 10 个标签、来源、自己的例句和可选试卷定位；收藏和插入是用户显式动作，工作台将当前编辑段落交给组件，在光标／选区位置插入并沿用编辑器长度校验，不自动套写整篇文章。

作文应用在预览及确认时重新读取并验证 writing 题型、题号唯一性、revision 与题目指纹，正文变化需重新预览；翻译同样在应用前验证本题类型和版本。共用 `applyAnswer` 对比预览的 `expectedAnswer` 与最新本题答案，冲突拒绝覆盖；成功合并最新试卷数据、仅改本题答案并清除已提交／评分状态，不丢其它题答案和标注。Reader 在 `storage`／返回时同步新答案，保存时对自身变化的题目与答案基线逐项比较；不同题增量合并，同题冲突显示保留本页／已保存版本的选择。这是浏览器本地的 CAS 式基线保护，不是数据库事务、云同步或多人协作服务。

`learning.html`／`learning.js` 汇集 Reader 标签笔记、翻译对照、作文上下文草稿／作答与表达。按记录类型和试卷筛选，关键词匹配标题、正文、标签和方法名称；有定位的记录可返回原卷，作文／翻译可继续编辑。重练模式先隐藏修改稿／成稿／笔记对照，用户重写后显式保存到 `cet:learning-review:v1`（最多 500 项），再自行展开；原笔记和答案不变，不带定时或间隔复习调度。

Markdown 导出当前筛选记录的完整内容，重练状态不会隐藏导出结果。JSON 格式 `cet-learning-backup` version 1，仅包含学习存储白名单及合法 `exam-viewer:*:v1`／阅读笔记草稿分区；UTF-8 导入最大 8MB，未知分区、不安全字段、损坏记录和超限合并拒绝恢复。恢复先预览／确认，触发下载现有本机备份后，按分区及记录 ID 合并，同 ID 以备份为准，不删除未包含记录；写入失败尝试回滚，若回滚也失败明确提示。备份可保留损坏原始文本供修复，但常规恢复拒绝未修复的原始损坏记录。请关闭其它编辑页恢复，并确认下载文件已保存；备份可能包含个人方法、笔记、表达、作答和试卷状态内的 AI 对话，不含服务端 PDF／音频或服务器密钥，不应公开分享或提交 Git。

### 固定翻译学习资料的显式导入

`server/learning_methods.py` 提供 `GET/HEAD /api/learning-methods/translation-notes`，只读本机缓存；缺失时返回 `status: not_imported`，不联网、不创建缓存目录。用户点击“加载 GitHub 笔记”／刷新才发起 `POST /api/learning-methods/translation-notes/refresh`，正文必须为空 JSON 对象 `{}`。服务只下载固定的 `TanGuilin520/CET6-Translation-Notes/master/翻译.md`，不接受用户网址或额外字段，也不读取模型密钥或调用 AI。

下载使用标准宿主 HTTPS 代理设置，目标 URL、重定向和最终来源均限制为同一公开 raw 文件；最多 256KB，8 秒下载期限，严格 UTF-8，并检查文件是否完整。资料按真实二级编号章节切分，三级注意点／例句留在所属方法中；实际源文有 18 节，不按照来源 README 的 19 类描述补写。方法卡为 `id/title/category/bodyMarkdown/keywords`，分类与关键词是确定性查找辅助，不是 AI 生成或语义 Embedding；源文例句不改写。

缓存用私有运行目录 `data/learning-methods/translation-notes.json`，保存原文、卡片和来源链接／归因／加载时间／SHA-256；通过临时文件、fsync 与原子替换保存。更新失败、超限、重复编号或解析不确定时保留旧缓存，GET 再次校验原文哈希及来源并重新解析，损坏缓存不自动覆盖。错误不向页面或日志暴露代理凭证或底层异常。运行目录加入 Git 忽略，不向 `public/` 放完整资料，不随公开平台代码分发课程笔记。

`translation-methods.js` 将“GitHub 总结”与“我的资料”分开显示；个人正文按编号标题浏览，普通自由文本仍能使用。目录查找覆盖标题、分类、关键词及正文；右侧通过安全 DOM 渲染 Markdown，原始 HTML 只作文字，不执行脚本、不加载远程图片。点击“记录本次使用”追加方法名称和来源／ID 关联到草稿，用户仍需正式保存；卡片读取当前浏览器按来源＋ID 匹配的历史应用，不回写源文。界面保留整理者及课程来源，明确个人学习资料不是官方答案解析；逐卡个人修订和具体选区／结构化错因完整双向关系仍未实现。

## 6. RAG、Agent v1 与 AI 辅导

答案 PDF 和明确答案切分后保存在各试卷 SQLite，并随复核发布复制到不可变 revision：

```text
同一试卷／revision
  ├─ Question ID 精确证据（建立当前题答案）
  └─ BM25＋哈希词项补充
       ＋ 可选离线本地 dense／RRF／重排序
                ↓
受限证据包
  ├─ question：可选 LangGraph 工具决策循环
  └─ general／selection：主服务直接请求 DeepSeek
                ↓
来源守卫＋面向用户 Markdown
```

题号精确结果永远优先；另一题的补充片段不能覆盖当前题答案。人工改正／移除答案时，新 revision 会清除同题旧的原始答案片段，来源区分上传答案 PDF 与人工核对。主服务先取得固定版本，之后在全局锁外读取不可变检索快照，避免本地模型冷索引阻塞其它试卷操作。

`server/retrieval.py` 采用 BM25、哈希词项和 reciprocal rank fusion；默认模式 `lexical_hash` 明确不是语义模型。管理员显式准备本地模型后，`services/embeddings` 提供 loopback-only dense Embedding／可选 CrossEncoder。不自动下载或调用付费 Embedding API，当前未预装权重。模型缺失／服务失败可继续词项检索；readiness 和完整／部分语义覆盖明确区分。每次最多生成 128 个新 chunk 向量，并限制新批次时间预算，首次大型资料不足显示 `hybrid_semantic_partial`。缓存绑定试卷／资料版本、模型内容指纹、维度和正文，损坏缓存不覆盖；私人笔记仅请求内排序，不写语义索引。详见 [本地模型服务](../services/embeddings/README.md)。

没有答案 PDF 官方解析时必须携带“答案资料中没有找到官方解析，以下为 AI 辅助分析”。没配置模型仍能展示已有明确资料，但不推断错误选项原因。来源匹配及 guard 不证明生成结论的语义正确性。配置模型后，当前题、用户问题／作答和被允许的资料会发送给 DeepSeek，需要明确披露这个边界；健康检查不验证余额或实际回答质量。

### 运行路径与工具

`bash tools/start.sh` 通过 `tools/start_platform.py` 联动主服务和已安装的 `.venv-agent`。只启动自己管理的子进程，共享本次 Token；不改 `.env`、不安装依赖、不下载模型或调用 LLM。直接 `python -m server` 仍只是原主服务入口。

题目 scope 的 LangGraph 在模型可用时执行模型决策／只读工具循环；六工具读取当前题、答案、证据、方法、授权笔记及现有选项。工具只访问主服务已经批准的有限 context，不能遍历上传目录、请求其它试卷、执行 Shell、任意 HTTP 或写答案。最多 4 决策轮、12 工具调用、30 秒及约 8,000 token 的估算／报告保护，不保证账单硬上限。无模型走原确定性保守图；已配置 sidecar 失败不会自动再走另一条付费模型路径。

自由／选段 scope 仍直连 DeepSeek，不伪装全部经过 LangGraph。回复附安全节点、工具与 `execution`，界面展示实际 readiness 与执行模式，不暴露隐藏推理。Reader 可为 writing／translation 传完整上限 12,000 字符的作答，客观题仍限 100；最终是否生成成功以本次 response 为准。

### 方法资料与授权

公开方法 RAG 只读固定、校验过的本机缓存，不触发 GitHub 下载；选定方法 ID 优先，之后用同一 BM25／哈希／可选本地语义检索。个人方法和有限历史笔记只有 `consentPersonal=true` 才能进入请求；关闭授权却携带私人资料会拒绝。方法、笔记来源独立于官方答案 `grounding`，有自己的 `learningCitations / learningGrounding`，永远不是官方解析。

翻译 UI 支持下一步提示、检查译段、按方法分析；当前选中的个人章节优先，超限明确提示。检索只处理本次授权内容，不扫浏览器全库／其它用户文件；模型工具进一步在这份有限证据包内排序。提示模式不给模型完整参考答案工具数据，无 Key 明确未生成辅导，不以完整答案代替下一步提示。

### 会话与显式清除

浏览器按题／scope 保存受限历史与稳定 conversation ID；题目版本改变不能混入旧题解。题目 Agent 路径额外在 SQLite 保留最近 6 轮及 1,200 字符提取式摘要；conversationId 与独立 Run checkpoint 分开。范围绑定试卷、题号、revision、题／答案和授权私人正文，变化后清除旧记忆及关联运行状态，避免恢复旧图重新引入撤销资料。

新建对话、撤销授权明确调用同源、本机清除接口。失败保留待删除标记、阻止旧私人上下文继续发送，刷新后继续处理；服务端删除标记防止更早排队／生成的调用重新保存旧记忆。取消／传输失败的孤立 checkpoint 也关联会话，后续范围变化／清除可删除。没有 Token 的 runtime 不宣传可管理会话；此保护不是登录、多用户身份或删除外部备份的承诺。

### SSE 和复核

`chat_stream.py` 为同一助手调用输出真实节点／工具进度、心跳和完整终态回复，有并发／缓冲／写入超时上限。最终 Markdown 仍整段返回，不是模型 token 流。停止生成通过 abort 和取消标志阻止后续工作／保存，已发外部请求不能撤回、可能计费；不重复发送模型请求来隐藏流错误。

复核 Agent 保持确定性的 suggest_only，只给当前 issue 字段建议，不调用模型、不自动保存。Review 再次检查题号、revision、字段白名单，用户应用到表单、核查、填写理由后才用 ETag 发布版本。完整接口与界限见 [Agent 架构](agent-architecture.md)。

### 评测

保留 5 条兼容案例，新增 60 条 v1 合成案例；`--offline` 用真实 LangGraph 和显式空模型配置执行，不继承真实 Key。可设置通过率／P95 门槛，输出来源文字匹配、答案标记及上游报告 usage。来源匹配不是 semantic entailment，答案标记不是教学质量，缺失 token 为未知。动态循环与语义 paraphrase 另用 mock 单测验证；真实模型质量、Recall@k/MRR 仍需要人工资料与明确授权的实测，见 [Evals](../evals/README.md)。

## 7. 听力

上传音频保存在试卷私有运行目录，通过同源 API 流式读取。接口支持 HTTP `Range`，所以浏览器可以拖动进度条而不必先下载完整音频。阅读器使用原生音频控件提供播放、暂停、进度与音量，并增加 0.75×–2.0× 倍速。

ASR、时间戳、题目音频片段及“记下此刻”听力时间点笔记尚未实现，数据模型与独立音频路由允许后续增量增加。

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

data/learning-methods/
└── translation-notes.json   显式加载的学习原文、方法卡、来源与哈希

data/retrieval/
└── semantic.sqlite3         可选本地向量与文档/模型/版本哈希（不存正文）

data/agent/
└── checkpoints.sqlite3      独立运行状态、有限会话与清除标记
```

- 上传、学习资料、语义索引与 Agent 运行数据不应提交 Git；完整学习笔记不作为公开静态资源或代码分发。
- 上传文件不放入 `public/`，只能通过严格 examId/文件名路由读取。
- POST/PATCH 接口拒绝跨源浏览器请求；当前复核 PATCH 还限制为本机 loopback，并要求 ETag 前置条件。loopback 只是本地开发保护，不是公网反向代理后的鉴权；对外部署前仍必须增加真实身份认证和授权。请求体、文件大小、页数、消息数和文本长度都有上限。
- 文件路由防目录穿越，并提供 `nosniff`；音频支持单段 Range。
- API 密钥仅由服务端环境读取，不进入 HTML、JavaScript 或 `localStorage`。
- 写作模板文件只在浏览器用严格 UTF-8 解码器读取，拒绝 NUL、错误后缀和超限内容；预览只写入 `textContent`/表单 `value`，不解析 HTML，也不上传服务器或自动发送给 AI。
- 这是本地单用户阶段，尚无登录和租户隔离；暴露到公网前必须增加鉴权、配额、病毒扫描、任务队列和对象存储。

## 9. 后续演进

下一阶段可在不改变阅读器五层结构的前提下增加：

1. 明确授权的视觉模型结构解析，并用当前规则和复核工作台做证据校验；
2. 用实际准备的本地语义模型测量 Recall@k/MRR、冷索引耗时与内存，再决定是否需要独立向量数据库；
3. ASR、音频时间戳和题目片段；
4. Users、Exams、Questions、UserAnswers、Annotations、AI Conversations 云端表；
5. 登录、权限、云同步与持久后台任务基础设施。
