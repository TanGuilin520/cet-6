(() => {
  'use strict';

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const builtInPapers = Object.freeze({
    '2021-06-01': {
      manifestUrl: '/api/papers/2021-06-01/manifest',
      assetRoot: 'assets/papers/2021-06-set-01/',
      sourceUrl: 'assets/papers/2021-06-set-01/source.pdf',
      questionsUrl: '/api/papers/2021-06-01/questions',
      answersUrl: '/api/papers/2021-06-01/answers',
      assistantUrl: '/api/papers/2021-06-01/assistant',
    },
  });
  const requestedPaperId = new URLSearchParams(location.search).get('paper') || '2021-06-01';
  const paperId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(requestedPaperId) ? requestedPaperId : '2021-06-01';
  const uploadedApiRoot = `/api/exams/${encodeURIComponent(paperId)}`;
  const paperConfig = builtInPapers[paperId] ? {
    id: paperId,
    builtIn: true,
    ...builtInPapers[paperId],
  } : {
    id: paperId,
    builtIn: false,
    manifestUrl: `${uploadedApiRoot}/manifest`,
    assetRoot: `${uploadedApiRoot}/`,
    sourceUrl: `${uploadedApiRoot}/source`,
    questionsUrl: `${uploadedApiRoot}/questions`,
    answersUrl: `${uploadedApiRoot}/answers`,
    assistantUrl: `${uploadedApiRoot}/assistant`,
  };
  const manifestUrl = paperConfig.manifestUrl;
  const assetRoot = paperConfig.assetRoot;
  const storageKey = `exam-viewer:${paperId}:v1`;
  const tools = new Set(['select', 'copy', 'line', 'highlight', 'eraser']);
  const tones = new Set(['amber', 'blue', 'green', 'purple']);
  const QUESTION_RAIL_WIDTH = 152;
  const MAX_TEMPLATE_FILE_BYTES = 64 * 1024;
  const MAX_TEMPLATE_SOURCE_CHARS = 12000;
  const MAX_LONG_ANSWER_CHARS = 12000;
  const viewer = $('#exam-viewer');
  const viewport = $('#document-viewport');
  const pagesNode = $('#document-pages');
  const thumbnailList = $('#thumbnail-list');
  const tagEditor = $('#tag-editor');
  const tagLabelInput = $('#tag-label');
  const tagNoteInput = $('#tag-note');
  const tagDeleteButton = $('#delete-tag');
  const questionWorkspace = $('#question-workspace');
  const questionNavigator = $('#question-navigator');
  const questionDetail = $('#question-detail');
  const examResult = $('#exam-result');
  const submitExamButton = $('#submit-exam');
  const aiQuestionPanel = $('#ai-question-panel');
  const aiQuestionMessages = $('#ai-question-messages');
  const wordLookup = typeof WordLookup !== 'undefined' ? WordLookup.create() : null;

  const stored = (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch { return {}; }
  })();

  function normalizeRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  function normalizeAnnotation(item) {
    if (!item || typeof item !== 'object') return null;
    const type = ['line', 'highlight', 'tag'].includes(item.type) ? item.type : '';
    const page = Math.max(1, Math.floor(Number(item.page) || 0));
    const id = String(item.id || '').trim();
    if (!type || !id) return null;
    if (type === 'line') {
      const values = ['x1', 'y1', 'x2', 'y2'].map((key) => Number(item[key]));
      if (!values.every(Number.isFinite)) return null;
      return {
        id, type, page,
        x1: values[0], y1: values[1], x2: values[2], y2: values[3],
        color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#d84a44',
        width: clamp(Number(item.width) || 2.1, 1, 8),
        createdAt: Number(item.createdAt) || Date.now(),
      };
    }
    const rects = Array.isArray(item.rects) ? item.rects.map(normalizeRect).filter(Boolean).slice(0, 80) : [];
    if (!rects.length) return null;
    const base = {
      id, type, page, rects,
      quote: String(item.quote || '').trim().slice(0, 1200),
      wordIds: Array.isArray(item.wordIds) ? item.wordIds.map(Number).filter(Number.isFinite).slice(0, 600) : [],
      createdAt: Number(item.createdAt) || Date.now(),
    };
    if (type === 'highlight') {
      base.color = /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#f6d64a';
    }
    if (type === 'tag') {
      base.label = String(item.label || '重点').trim().slice(0, 16) || '重点';
      base.note = String(item.note || '').trim().slice(0, 260);
      base.tone = tones.has(item.tone) ? item.tone : 'amber';
    }
    return base;
  }

  function normalizeStoredAnswers(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 300).map(([key, answer]) => [String(key), String(answer || '').slice(0, 12000)]));
  }

  function normalizeAiCitation(item) {
    if (!item || typeof item !== 'object') return null;
    const pageValue = Number(item.page);
    const citation = {
      source: String(item.source ?? item.kind ?? '').trim().slice(0, 80),
      label: String(item.label ?? item.title ?? '').trim().slice(0, 160),
      page: Number.isInteger(pageValue) && pageValue > 0 ? pageValue : null,
      questionId: String(item.questionId ?? '').trim().slice(0, 40),
      quote: String(item.quote ?? item.excerpt ?? item.content ?? item.text ?? '').trim().slice(0, 360),
    };
    return citation.source || citation.label || citation.page || citation.questionId || citation.quote ? citation : null;
  }

  function normalizeAiCitations(value) {
    return (Array.isArray(value) ? value : []).map(normalizeAiCitation).filter(Boolean).slice(0, 6);
  }

  function normalizeAiGeneration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const FALLBACK_REASONS = new Set([
      'not_configured', 'invalid_configuration', 'blocked_mutation',
      'upstream_timeout', 'upstream_auth_error', 'upstream_rate_limited',
      'upstream_server_error', 'invalid_response', 'agent_transport_error',
    ]);
    const model = String(value.model ?? '').trim().slice(0, 160);
    const fallbackReason = String(value.fallbackReason ?? '').trim();
    const usage = value.usage && typeof value.usage === 'object'
      ? ['promptTokens', 'completionTokens', 'totalTokens'].reduce((acc, key) => {
        const number = Number(value.usage[key]);
        if (Number.isInteger(number) && number >= 0) acc[key] = number;
        return acc;
      }, {})
      : null;
    const generation = {
      provider: value.provider === 'deepseek' ? 'deepseek' : 'deterministic',
      model: model || null,
      attempted: value.attempted === true,
      used: value.used === true && value.provider === 'deepseek',
      fallbackReason: FALLBACK_REASONS.has(fallbackReason) ? fallbackReason : null,
      usage: usage && Object.keys(usage).length ? usage : null,
    };
    if (!generation.used) generation.usage = null;
    return generation;
  }

  function normalizeAiAgent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rawTools = Array.isArray(value.tools) ? value.tools : [];
    const tools = rawTools.map((tool) => {
      if (typeof tool === 'string') return { name: tool.trim().slice(0, 80), status: '', summary: '' };
      if (!tool || typeof tool !== 'object') return null;
      return {
        name: String(tool.name || '').trim().slice(0, 80),
        status: String(tool.status || '').trim().slice(0, 40),
        summary: String(tool.summary || '').trim().slice(0, 160),
      };
    }).filter((tool) => tool?.name).slice(0, 12);
    const rawTrace = value.trace && typeof value.trace === 'object' && !Array.isArray(value.trace) ? value.trace : {};
    const rawNodes = Array.isArray(rawTrace.nodes)
      ? rawTrace.nodes
      : Array.isArray(value.trace) ? value.trace : [];
    const nodes = rawNodes.map((node) => String(node || '').trim().slice(0, 80)).filter(Boolean).slice(0, 16);
    const durationValue = Number(rawTrace.durationMs);
    const agent = {
      runId: String(value.runId ?? rawTrace.runId ?? '').trim().slice(0, 160),
      intent: String(value.intent || '').trim().slice(0, 160),
      tools,
      trace: {
        nodes,
        durationMs: Number.isFinite(durationValue) && durationValue >= 0 ? Math.round(durationValue) : null,
      },
    };
    return agent.runId || agent.intent || agent.tools.length || agent.trace.nodes.length || agent.trace.durationMs !== null
      ? agent
      : null;
  }

  function normalizeStoredHistory(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value).slice(-40).map(([questionId, messages]) => {
      const cleanMessages = Array.isArray(messages) ? messages.slice(-12).map((message) => {
        const clean = {
          role: message?.role === 'assistant' ? 'assistant' : 'user',
          content: String(message?.content || '').slice(0, 2500),
        };
        if (clean.role === 'assistant') {
          const citations = normalizeAiCitations(message?.citations);
          const agent = normalizeAiAgent(message?.agent);
          const generation = normalizeAiGeneration(message?.generation);
          if (citations.length) clean.citations = citations;
          if (agent) clean.agent = agent;
          if (generation) clean.generation = generation;
        }
        return clean;
      }).filter((message) => message.content) : [];
      return [String(questionId), cleanMessages];
    });
    return Object.fromEntries(entries);
  }

  function normalizeStoredRevision(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function normalizeStoredThread(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-24).flatMap((message) => {
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(message?.content || '').slice(0, 8000);
      if (!content.trim()) return [];
      const clean = { role, content };
      if (role === 'assistant') {
        const generation = normalizeAiGeneration(message?.generation);
        const citations = normalizeAiCitations(message?.citations);
        if (generation) clean.generation = generation;
        if (citations.length) clean.citations = citations;
        if (message?.sourceBadge === 'official') clean.sourceBadge = 'official';
        else if (message?.sourceBadge === 'ai') clean.sourceBadge = 'ai';
      }
      return [clean];
    });
  }

  function parseWritingTemplate(source, previousSlots = []) {
    const text = String(source || '').replace(/\0/g, '').slice(0, MAX_TEMPLATE_SOURCE_CHARS);
    const previous = new Map((Array.isArray(previousSlots) ? previousSlots : []).map((slot) => [String(slot?.name || ''), String(slot?.value || '')]));
    const names = [];
    text.replace(/\{\{\s*([^{}\r\n]{1,40}?)\s*\}\}/g, (match, rawName) => {
      const name = String(rawName || '').trim();
      if (name && !names.includes(name) && names.length < 40) names.push(name);
      return match;
    });
    return {
      source: text,
      slots: names.map((name) => ({ name, value: String(previous.get(name) || '').slice(0, 1000) })),
    };
  }

  function normalizeStoredWritingTemplates(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const templates = {};
    Object.entries(value).slice(0, 10).forEach(([questionId, template]) => {
      if (!/^(?:writing-|q)\d{1,3}$/.test(questionId) || !template || typeof template !== 'object') return;
      const parsed = parseWritingTemplate(template.source, template.slots || template.values);
      if (!parsed.source || !parsed.slots.length) return;
      templates[questionId] = {
        version: 1,
        name: String(template.name || '写作模板.txt').slice(0, 160),
        source: parsed.source,
        slots: parsed.slots,
        updatedAt: Number(template.updatedAt) || Date.now(),
        lastAppliedAt: Number(template.lastAppliedAt) || 0,
      };
    });
    return templates;
  }

  const state = {
    tool: tools.has(stored.tool) ? stored.tool : 'select',
    zoom: clamp(Number(stored.zoom) || 1, .55, 1.9),
    lineColor: /^#[0-9a-f]{6}$/i.test(String(stored.lineColor || '')) ? stored.lineColor : '#d84a44',
    highlightColor: /^#[0-9a-f]{6}$/i.test(String(stored.highlightColor || '')) ? stored.highlightColor : '#f6d64a',
    annotations: Array.isArray(stored.annotations) ? stored.annotations.map(normalizeAnnotation).filter(Boolean).slice(-1000) : [],
    thumbnails: stored.thumbnails !== false,
    notesPanel: stored.notesPanel !== false,
    answers: normalizeStoredAnswers(stored.answers),
    flagged: new Set(Array.isArray(stored.flagged) ? stored.flagged.map(String).slice(0, 300) : []),
    currentQuestionId: String(stored.currentQuestionId || ''),
    submitted: stored.submitted === true,
    grade: stored.grade && typeof stored.grade === 'object' ? stored.grade : null,
    aiHistory: normalizeStoredHistory(stored.aiHistory),
    aiHistoryRevision: normalizeStoredRevision(stored.aiHistoryRevision),
    aiFreeHistory: normalizeStoredThread(stored.aiFreeHistory),
    aiSelectionHistory: normalizeStoredThread(stored.aiSelectionHistory),
    writingTemplates: normalizeStoredWritingTemplates(stored.writingTemplates),
    history: [],
  };

  let manifest = null;
  let fitScale = 1;
  let currentPage = 1;
  let activePointer = null;
  let erasedDuringGesture = [];
  let pendingSelection = null;
  let pendingCopy = null;
  let activeTag = null;
  let activeTagTone = 'amber';
  let toastTimer = 0;
  let saveTimer = 0;
  let scrollFrame = 0;
  let questions = [];
  let answerKey = new Map();
  let questionReviewSummary = null;
  let answerReviewSummary = null;
  let questionDataRevision = null;
  let questionDataEtag = '';
  let expandedQuestionId = '';
  let aiPanelQuestionId = '';
  let assistantRequestId = 0;
  let aiScope = 'question';
  let aiSelectionText = '';
  let aiChatBusy = false;
  let aiCompositionActive = false;
  let aiLastFailure = null;
  const assistantPendingQuestions = new Set();
  const aiQuestionDrafts = new Map();
  let selectionChangeTimer = 0;
  let selectionPointerActive = false;
  let copyPanelReturnFocus = null;
  let questionFocusRequest = null;
  const pageViews = new Map();

  const cloneAnnotation = (annotation) => ({
    ...annotation,
    rects: annotation.rects?.map((rect) => ({ ...rect })),
    wordIds: annotation.wordIds ? [...annotation.wordIds] : undefined,
  });

  function showToast(message) {
    const toast = $('#viewer-toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  async function copyTextWithFallback(text) {
    const value = String(text || '');
    if (!value) return false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch { /* fall through to the synchronous browser fallback */ }
    }
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute('aria-label', '临时复制文本');
    Object.assign(textarea.style, {
      position: 'fixed', left: '-9999px', top: '0', opacity: '0', pointerEvents: 'none',
    });
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try { copied = document.execCommand('copy'); }
    catch { copied = false; }
    textarea.remove();
    previousFocus?.focus?.({ preventScroll: true });
    return copied;
  }

  function resolveAssetUrl(value) {
    const path = String(value || '').trim();
    if (!path) return '';
    if (/^(?:https?:|data:|blob:)/i.test(path) || path.startsWith('/')) return path;
    return `${assetRoot}${path.replace(/^\.\//, '')}`;
  }

  function normalizeQuestionBBox(raw, pageNumber) {
    if (!raw) return null;
    const page = pageViews.get(pageNumber)?.page || manifest?.pages?.find((item) => Number(item.number) === pageNumber);
    let x;
    let y;
    let width;
    let height;
    if (Array.isArray(raw) && raw.length >= 4) [x, y, width, height] = raw.map(Number);
    else if (typeof raw === 'object') {
      x = Number(raw.x ?? raw.left ?? raw.xMin ?? raw.x0 ?? raw.x1);
      y = Number(raw.y ?? raw.top ?? raw.yMin ?? raw.y0 ?? raw.y1);
      const right = Number(raw.right ?? raw.xMax ?? raw.x2 ?? (raw.x0 !== undefined ? raw.x1 : NaN));
      const bottom = Number(raw.bottom ?? raw.yMax ?? raw.y2 ?? (raw.y0 !== undefined ? raw.y1 : NaN));
      width = Number(raw.width ?? (right - x));
      height = Number(raw.height ?? (bottom - y));
    }
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    if (page && x >= 0 && y >= 0 && width <= 1.5 && height <= 1.5 && x + width <= 1.6 && y + height <= 1.6) {
      x *= page.width;
      width *= page.width;
      y *= page.height;
      height *= page.height;
    }
    if (page) {
      x = clamp(x, 0, page.width);
      y = clamp(y, 0, page.height);
      width = clamp(width, 1, page.width - x || 1);
      height = clamp(height, 1, page.height - y || 1);
    }
    return { x, y, width, height };
  }

  function normalizeQuestionOptions(value) {
    const source = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.entries(value).map(([key, text]) => ({ key, text }))
        : [];
    const seen = new Set();
    return source.slice(0, 15).map((option, index) => {
      const key = String(option?.key ?? option?.label ?? option?.id ?? String.fromCharCode(65 + index)).trim().toUpperCase();
      const text = String(option?.text ?? option?.content ?? option?.value ?? option ?? '').trim();
      return { key: key || String.fromCharCode(65 + index), text };
    }).filter((option) => {
      if (!option.key || seen.has(option.key)) return false;
      seen.add(option.key);
      return true;
    }).sort((a, b) => a.key.localeCompare(b.key, 'en'));
  }

  function normalizeConfidence(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const score = numeric <= 1 ? numeric : numeric / 100;
      return { score: clamp(score, 0, 1), label: `${Math.round(clamp(score, 0, 1) * 100)}%` };
    }
    const text = String(value).trim();
    const lower = text.toLowerCase();
    const score = /high|高/.test(lower) ? .9 : /medium|中/.test(lower) ? .65 : /low|低/.test(lower) ? .35 : null;
    return { score, label: text.slice(0, 24) };
  }

  function normalizeQuestion(item, index) {
    if (!item || typeof item !== 'object') return null;
    const questionId = String(item.questionId ?? item.id ?? item.number ?? index + 1).trim();
    if (!questionId) return null;
    const number = String(item.number ?? item.questionNumber ?? questionId).trim();
    const page = Math.max(1, Math.floor(Number(item.page ?? item.bbox?.page ?? item.position?.page) || 1));
    const options = normalizeQuestionOptions(item.options ?? item.choices);
    const type = String(item.type || (options.length ? 'single-choice' : 'long-text')).toLowerCase();
    const confidence = normalizeConfidence(item.confidence);
    return {
      id: questionId,
      number,
      type,
      page,
      bbox: normalizeQuestionBBox(item.bbox ?? item.rect ?? item.position?.bbox, page),
      stem: String(item.stem ?? item.prompt ?? item.question ?? item.text ?? `第 ${number} 题`).trim().slice(0, 6000),
      options,
      objective: options.length > 1 || /choice|single|multiple|objective/.test(type),
      confidence,
      reviewRequired: item.reviewRequired === true || item.needsReview === true || Boolean(confidence && confidence.score !== null && confidence.score < .6),
      reviewReason: String(item.reviewReason ?? item.reviewLabel ?? item.review ?? '').trim().slice(0, 500),
      section: String(item.section ?? item.module ?? '').trim().slice(0, 80),
    };
  }

  function normalizeQuestionsPayload(payload) {
    const source = Array.isArray(payload) ? payload : payload?.questions ?? payload?.data?.questions ?? [];
    questionReviewSummary = payload?.reviewSummary ?? payload?.data?.reviewSummary ?? null;
    const seen = new Set();
    return (Array.isArray(source) ? source : []).map(normalizeQuestion).filter((question) => {
      if (!question || seen.has(question.id)) return false;
      seen.add(question.id);
      return true;
    }).sort((a, b) => (
      a.page - b.page
      || Number(a.bbox?.y ?? Number.MAX_SAFE_INTEGER) - Number(b.bbox?.y ?? Number.MAX_SAFE_INTEGER)
      || (Number(a.number) || Number.MAX_SAFE_INTEGER) - (Number(b.number) || Number.MAX_SAFE_INTEGER)
    ));
  }

  function normalizeAnswerKey(payload) {
    const source = Array.isArray(payload) ? payload : payload?.answers ?? payload?.answerKey ?? payload?.data?.answers ?? [];
    answerReviewSummary = payload?.reviewSummary ?? payload?.data?.reviewSummary ?? null;
    const entries = Array.isArray(source) ? source : Object.entries(source || {}).map(([questionId, answer]) => (
      answer && typeof answer === 'object' ? { questionId, ...answer } : { questionId, answer }
    ));
    return new Map(entries.map((item, index) => {
      const questionId = String(item?.questionId ?? item?.id ?? item?.number ?? index + 1).trim();
      const answer = String(item?.answer ?? item?.correctAnswer ?? item?.correct ?? '').trim().toUpperCase();
      return [questionId, {
        answer,
        explanation: String(item?.explanation ?? item?.analysis ?? '').trim().slice(0, 8000),
        confidence: normalizeConfidence(item?.confidence),
        reviewRequired: item?.reviewRequired === true || item?.needsReview === true,
        source: String(item?.source ?? '').trim().slice(0, 300),
      }];
    }).filter(([questionId, value]) => questionId && value.answer));
  }

  function reviewVersionFromResponse(response, payload) {
    const etag = String(response?.headers?.get('ETag') || '').trim();
    const match = /^"review-r(0|[1-9]\d*)"$/.exec(etag);
    const payloadRevision = Number(payload?.revision);
    return {
      etag: match ? etag : '',
      revision: match
        ? Number(match[1])
        : Number.isInteger(payloadRevision) && payloadRevision >= 0 ? payloadRevision : null,
    };
  }

  function versionedDocumentHeaders() {
    return questionDataEtag
      ? { Accept: 'application/json', 'If-Match': questionDataEtag }
      : { Accept: 'application/json' };
  }

  function currentQuestion() {
    return questions.find((question) => question.id === state.currentQuestionId) || questions[0] || null;
  }

  function questionLabel(question) {
    const number = String(question?.number || '').trim();
    return /^\d+$/.test(number) ? `第 ${number} 题` : `${number || '本'}题`;
  }

  function questionStatus(question) {
    const answer = String(state.answers[question.id] || '').trim();
    const official = answerKey.get(question.id);
    const confidenceScore = (official?.confidence || question.confidence)?.score;
    return {
      answered: Boolean(answer),
      flagged: state.flagged.has(question.id),
      current: question.id === state.currentQuestionId,
      correct: Boolean(state.submitted && official?.answer && answer.toUpperCase() === official.answer),
      wrong: Boolean(state.submitted && official?.answer && answer && answer.toUpperCase() !== official.answer),
      lowConfidence: Number.isFinite(confidenceScore) && confidenceScore < .6,
      needsReview: Boolean(official?.reviewRequired || question.reviewRequired),
    };
  }

  function cleanLookupWord(value) {
    const normalized = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/([A-Za-z])\.(?=[A-Za-z])/g, '$1')
      .trim();
    const match = normalized.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/);
    return match ? match[0].replace(/’/g, "'") : '';
  }

  function closeWordPopover() {
    wordLookup?.close();
  }

  function openWordPopover(target, value) {
    if (!wordLookup) return;
    closeTagEditor();
    wordLookup.open(target, value);
  }

  function save() {
    const indicator = $('#save-indicator');
    indicator?.classList.remove('is-error');
    indicator?.classList.add('is-saving');
    if (indicator) indicator.lastChild.textContent = ' 保存中';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          tool: state.tool,
          zoom: state.zoom,
          lineColor: state.lineColor,
          highlightColor: state.highlightColor,
          annotations: state.annotations,
          thumbnails: state.thumbnails,
          notesPanel: state.notesPanel,
          answers: state.answers,
          flagged: [...state.flagged],
          currentQuestionId: state.currentQuestionId,
          submitted: state.submitted,
          grade: state.grade,
          aiHistory: normalizeStoredHistory(state.aiHistory),
          aiHistoryRevision: state.aiHistoryRevision,
          aiFreeHistory: normalizeStoredThread(state.aiFreeHistory),
          aiSelectionHistory: normalizeStoredThread(state.aiSelectionHistory),
          writingTemplates: normalizeStoredWritingTemplates(state.writingTemplates),
        }));
        indicator?.classList.remove('is-saving');
        if (indicator) indicator.lastChild.textContent = ' 已自动保存';
      } catch {
        indicator?.classList.remove('is-saving');
        indicator?.classList.add('is-error');
        if (indicator) indicator.lastChild.textContent = ' 保存失败';
        showToast('本地存储空间不足，当前标注未能保存');
      }
    }, 180);
  }

  function pushHistory(action) {
    state.history.push(action);
    state.history = state.history.slice(-80);
    updateToolbar();
  }

  function pageModule(pageNumber) {
    if (!paperConfig.builtIn) return `试卷第 ${pageNumber} 页`;
    if (pageNumber === 1) return '写作 · 听力 1–6';
    if (pageNumber === 2) return '听力 7–17';
    if (pageNumber === 3) return '听力 18–25 · 阅读';
    if (pageNumber <= 5) return '阅读 Section A / B';
    if (pageNumber <= 7) return '阅读 Section B / C';
    return '阅读 51–55 · 翻译';
  }

  function updateToolbar() {
    viewer.dataset.tool = state.tool;
    $$('.tool-button[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool)));
    const undo = $('#undo-mark');
    if (undo) undo.disabled = state.history.length === 0;
    const color = $('#line-color');
    if (color && color.value !== state.lineColor) color.value = state.lineColor;
    const highlightColor = $('#highlight-color');
    if (highlightColor && highlightColor.value !== state.highlightColor) highlightColor.value = state.highlightColor;
    viewer.style.setProperty('--active-highlight-color', state.highlightColor);
    viewer.classList.toggle('is-thumbnails-hidden', !state.thumbnails);
    viewer.classList.toggle('is-notes-hidden', !state.notesPanel);
    $('#toggle-thumbnails')?.setAttribute('aria-pressed', String(state.thumbnails));
    $('#toggle-notes')?.setAttribute('aria-pressed', String(state.notesPanel));
    const guide = $('#tool-guide');
    const guideText = {
      select: ['查词 / 选段标签', '单击单词可查中文释义并朗读；拖选一段文字可记录标签。'],
      copy: ['选段复制', '拖选 PDF 文字，在确认面板中复制为纯文本。'],
      line: ['直线工具', '按下确定起点，拖动预览，松开得到笔直线段。'],
      highlight: ['矩形荧光笔', '拖选文字后按每行文字边界生成规整长方形。'],
      eraser: ['橡皮擦', '按住并划过直线、荧光标记或标签即可删除。'],
    }[state.tool];
    if (guide && guideText) {
      $('b', guide).textContent = guideText[0];
      $('p', guide).textContent = guideText[1];
      $('.guide-icon', guide).textContent = state.tool === 'line' ? '／' : state.tool === 'highlight' ? '▰' : state.tool === 'eraser' ? '⌫' : state.tool === 'copy' ? '⧉' : 'T';
    }
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function createPageView(page) {
    const shell = document.createElement('section');
    const surface = document.createElement('div');
    const image = document.createElement('img');
    const markup = createSvgElement('svg', { viewBox: `0 0 ${page.width} ${page.height}`, preserveAspectRatio: 'none' });
    const textLayer = document.createElement('div');
    const badgeLayer = document.createElement('div');
    const questionLayer = document.createElement('div');
    const pageBadge = document.createElement('span');

    shell.className = 'pdf-page-shell';
    shell.dataset.page = String(page.number);
    surface.className = 'pdf-page-surface';
    Object.assign(surface.style, { width: `${page.width}px`, height: `${page.height}px` });
    image.className = 'page-image';
    image.src = resolveAssetUrl(page.image);
    image.alt = `完整试卷第 ${page.number} 页`;
    image.loading = page.number <= 2 ? 'eager' : 'lazy';
    image.draggable = false;
    markup.classList.add('page-markup-layer');
    markup.dataset.page = String(page.number);
    textLayer.className = 'page-text-layer';
    textLayer.dataset.page = String(page.number);
    badgeLayer.className = 'page-badge-layer';
    questionLayer.className = 'page-question-layer';
    questionLayer.dataset.page = String(page.number);
    pageBadge.className = 'page-number-badge';
    pageBadge.textContent = `${page.number} / ${manifest.pageCount}`;

    const wordFragment = document.createDocumentFragment();
    (Array.isArray(page.words) ? page.words : []).forEach((word, order) => {
      const span = document.createElement('span');
      span.className = 'pdf-word';
      span.dataset.page = String(page.number);
      span.dataset.wordId = String(word.id);
      span.dataset.line = String(word.line);
      span.dataset.order = String(order);
      span.dataset.x = String(word.x);
      span.dataset.y = String(word.y);
      span.dataset.width = String(word.width);
      span.dataset.height = String(word.height);
      span.dataset.word = word.text;
      span.textContent = `${word.text}\u00a0`;
      Object.assign(span.style, {
        left: `${word.x}px`,
        top: `${word.y}px`,
        width: `${Math.max(word.width + 2, 3)}px`,
        height: `${Math.max(word.height, 3)}px`,
        fontSize: `${Math.max(word.height * .86, 3)}px`,
      });
      wordFragment.append(span);
    });
    textLayer.append(wordFragment);
    surface.append(image, markup, textLayer, badgeLayer, questionLayer, pageBadge);
    shell.append(surface);
    pagesNode.append(shell);

    const view = { page, shell, surface, image, markup, textLayer, badgeLayer, questionLayer };
    pageViews.set(page.number, view);
    attachMarkupEvents(view);
    return view;
  }

  function createThumbnail(page) {
    const button = document.createElement('button');
    const image = document.createElement('img');
    const meta = document.createElement('span');
    const number = document.createElement('b');
    const module = document.createElement('small');
    button.type = 'button';
    button.className = 'thumbnail-button';
    button.dataset.thumbnailPage = String(page.number);
    image.className = 'thumbnail-image';
    image.src = resolveAssetUrl(page.image);
    image.alt = '';
    image.loading = 'lazy';
    image.style.aspectRatio = `${page.width} / ${page.height}`;
    meta.className = 'thumbnail-meta';
    number.textContent = `第 ${page.number} 页`;
    module.textContent = pageModule(page.number);
    meta.append(number, module);
    button.append(image, meta);
    thumbnailList.append(button);
  }

  function calculateFitScale() {
    if (!manifest || !viewport) return 1;
    const available = Math.max(280, viewport.clientWidth - (innerWidth <= 680 ? 16 : 70));
    const hasRail = questions.some((question) => manifest.pages.some((page) => question.page === page.number));
    const widestPage = Math.max(...manifest.pages.map((page) => page.width)) + (hasRail ? QUESTION_RAIL_WIDTH : 0);
    return clamp(available / widestPage, .35, 1.36);
  }

  function applyScale() {
    if (!manifest) return;
    fitScale = calculateFitScale();
    const totalScale = fitScale * state.zoom;
    pageViews.forEach(({ page, shell, surface }) => {
      const railWidth = questions.length ? QUESTION_RAIL_WIDTH : 0;
      shell.style.width = `${(page.width + railWidth) * totalScale}px`;
      shell.style.height = `${page.height * totalScale}px`;
      surface.style.left = `${railWidth * totalScale}px`;
      surface.style.transform = `scale(${totalScale})`;
    });
    const zoom = $('#zoom-value');
    if (zoom) zoom.textContent = state.zoom === 1 ? '适合宽度' : `${Math.round(state.zoom * 100)}%`;
  }

  function makeElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = text;
    return element;
  }

  function setQuestionStateClasses(element, status) {
    element.classList.toggle('is-current', status.current);
    element.classList.toggle('is-answered', status.answered);
    element.classList.toggle('is-flagged', status.flagged);
    element.classList.toggle('is-low-confidence', status.lowConfidence);
    element.classList.toggle('needs-review', status.needsReview);
  }

  function renderPageQuestions(pageNumber) {
    const view = pageViews.get(pageNumber);
    if (!view?.questionLayer) return;
    view.questionLayer.replaceChildren();
    const pageQuestions = questions.filter((question) => question.page === pageNumber).sort((left, right) => {
      const leftY = Number.isFinite(left.bbox?.y) ? left.bbox.y : Number.POSITIVE_INFINITY;
      const rightY = Number.isFinite(right.bbox?.y) ? right.bbox.y : Number.POSITIVE_INFINITY;
      return leftY - rightY || String(left.number).localeCompare(String(right.number), 'zh-CN', { numeric: true });
    });
    const controlsDisabled = state.tool === 'line' || state.tool === 'eraser';
    const renderedCards = [];
    pageQuestions.forEach((question, index) => {
      const status = questionStatus(question);
      const official = answerKey.get(question.id);
      const selected = String(state.answers[question.id] || '').toUpperCase();
      const bbox = question.bbox;
      const expanded = expandedQuestionId === question.id;

      const card = makeElement('div', `page-question-card${expanded ? ' is-expanded' : ''}`);
      card.dataset.questionId = question.id;
      card.dataset.questionAnchor = question.id;
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', questionLabel(question));
      setQuestionStateClasses(card, status);
      const desiredTop = bbox ? bbox.y : 18 + index * 30;
      card.style.right = 'calc(100% + 5px)';

      const numberButton = makeElement('button', 'page-question-number', question.number);
      numberButton.type = 'button';
      numberButton.disabled = controlsDisabled;
      numberButton.setAttribute('data-toggle-page-question', question.id);
      numberButton.setAttribute('aria-expanded', String(expanded));
      numberButton.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${questionLabel(question)}答案选项`);
      numberButton.dataset.answer = question.objective ? selected : status.answered ? '✓' : '';
      numberButton.title = expanded ? `收起${questionLabel(question)}选项` : `选择${questionLabel(question)}答案`;
      card.append(numberButton);

      if (expanded && question.objective) {
        const optionGroup = makeElement('div', 'page-question-options');
        optionGroup.setAttribute('role', 'group');
        optionGroup.setAttribute('aria-label', `${questionLabel(question)}选项`);
        question.options.forEach((option) => {
          const button = makeElement('button', 'page-question-option', option.key);
          button.type = 'button';
          button.disabled = controlsDisabled;
          button.dataset.questionOption = question.id;
          button.dataset.optionKey = option.key;
          button.title = option.text ? `${option.key}. ${option.text}` : `选择 ${option.key}`;
          button.setAttribute('aria-pressed', String(selected === option.key));
          button.classList.toggle('is-selected', selected === option.key && !state.submitted);
          button.classList.toggle('is-correct', Boolean(state.submitted && official?.answer === option.key));
          button.classList.toggle('is-wrong', Boolean(state.submitted && selected === option.key && official?.answer !== option.key));
          optionGroup.append(button);
        });
        card.append(optionGroup);
      } else if (expanded) {
        const answerButton = makeElement('button', 'page-question-text-button', status.answered ? '已作答' : '作答');
        answerButton.type = 'button';
        answerButton.disabled = controlsDisabled;
        answerButton.dataset.openQuestion = question.id;
        card.append(answerButton);
      }
      view.questionLayer.append(card);
      renderedCards.push({ card, desiredTop });
    });
    let previousBottom = 1;
    const layouts = renderedCards.map(({ card, desiredTop }) => {
      const height = Math.max(card.offsetHeight, 26);
      const top = Math.max(clamp(desiredTop, 4, view.page.height - height), previousBottom + 3);
      previousBottom = top + height;
      return { card, height, top };
    });
    const overflow = Math.max(0, previousBottom - (view.page.height - 4));
    const availableShift = layouts.length ? Math.max(0, layouts[0].top - 4) : 0;
    const shift = Math.min(overflow, availableShift);
    layouts.forEach(({ card, top }) => { card.style.top = `${top - shift}px`; });
    if (questionFocusRequest?.page === pageNumber) {
      const request = questionFocusRequest;
      questionFocusRequest = null;
      requestAnimationFrame(() => {
        const selector = request.option
          ? `[data-question-option="${CSS.escape(request.questionId)}"][data-option-key="${CSS.escape(request.option)}"]`
          : `[data-toggle-page-question="${CSS.escape(request.questionId)}"]`;
        $(selector, view.questionLayer)?.focus({ preventScroll: true });
      });
    }
  }

  function renderAllPageQuestions() {
    pageViews.forEach((_, pageNumber) => renderPageQuestions(pageNumber));
  }

  function renderQuestionProgress() {
    if (!questions.length) return;
    const answered = questions.filter((question) => String(state.answers[question.id] || '').trim()).length;
    const flagged = questions.filter((question) => state.flagged.has(question.id)).length;
    const unresolved = Math.max(0, Number(questionReviewSummary?.unresolved) || 0);
    const percent = questions.length ? answered / questions.length * 100 : 0;
    $('#answered-count').textContent = String(answered);
    $('#question-total').textContent = `/ ${questions.length} 已作答`;
    $('#flagged-count').textContent = unresolved
      ? `${flagged} 道待复查 · ${unresolved} 题未识别`
      : `${flagged} 道待复查`;
    $('#question-progress-bar').style.width = `${percent}%`;
    const progress = $('.question-progress-track');
    progress?.setAttribute('aria-valuemax', String(questions.length));
    progress?.setAttribute('aria-valuenow', String(answered));
    $('#toolbar-answer-count').textContent = `${answered}/${questions.length}`;
  }

  function renderQuestionNavigator() {
    if (!questionNavigator) return;
    questionNavigator.replaceChildren();
    questions.forEach((question) => {
      const status = questionStatus(question);
      const button = makeElement('button', 'question-nav-button', question.number);
      button.type = 'button';
      button.dataset.navigateQuestion = question.id;
      button.title = `${questionLabel(question)} · 第 ${question.page} 页`;
      button.setAttribute('aria-current', status.current ? 'true' : 'false');
      setQuestionStateClasses(button, status);
      questionNavigator.append(button);
    });
  }

  function appendConfidenceAndReview(container, question, official) {
    const confidence = official?.confidence || question.confidence;
    const reviewRequired = official?.reviewRequired || question.reviewRequired;
    if (!confidence && !reviewRequired) return;
    const meta = makeElement('div', 'question-meta');
    if (confidence) {
      const badge = makeElement('span', `confidence-badge${confidence.score !== null && confidence.score < .6 ? ' confidence-badge--low' : ''}`, `解析置信度 ${confidence.label}`);
      meta.append(badge);
    }
    if (reviewRequired) {
      const reason = question.reviewReason ? `：${question.reviewReason}` : '';
      const badge = makeElement('span', 'review-badge', `建议人工复查${reason}`);
      meta.append(badge);
    }
    container.append(meta);
  }

  function compileWritingTemplate(template, showPlaceholders = true) {
    if (!template) return '';
    return String(template.source || '').replace(/\{\{\s*([^{}\r\n]{1,40}?)\s*\}\}/g, (match, rawName) => {
      const name = String(rawName || '').trim();
      const slot = template.slots.find((item) => item.name === name);
      const value = String(slot?.value || '').trim();
      return value || (showPlaceholders ? `【${name}】` : match);
    });
  }

  function updateWritingTemplatePreview(questionId) {
    const builder = $('[data-writing-template-builder]', questionDetail);
    const preview = $('[data-writing-template-preview]', builder);
    const template = state.writingTemplates[questionId];
    if (preview && template) preview.textContent = compileWritingTemplate(template, true);
  }

  function renderWritingTemplateBuilder(question) {
    const builder = makeElement('section', 'writing-template-builder');
    builder.dataset.writingTemplateBuilder = question.id;
    const template = state.writingTemplates[question.id];
    const header = makeElement('header');
    const heading = makeElement('div');
    heading.append(
      makeElement('b', '', '写作模板填空'),
      makeElement('p', '', template ? `当前模板：${template.name}` : '上传包含 {{主题}}、{{理由1}} 等占位符的 TXT 或 Markdown 模板。'),
    );
    const uploadButton = makeElement('button', '', template ? '更换模板' : '上传模板');
    uploadButton.type = 'button';
    uploadButton.dataset.importWritingTemplate = question.id;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    fileInput.accept = '.txt,.md,text/plain,text/markdown';
    fileInput.dataset.writingTemplateFile = question.id;
    header.append(heading, uploadButton, fileInput);
    builder.append(header);

    if (!template) {
      builder.append(makeElement('p', 'writing-template-preview', ''));
      return builder;
    }

    const slots = makeElement('div', 'writing-template-slots');
    template.slots.forEach((slot, index) => {
      const field = makeElement('div', 'writing-template-slot');
      const label = makeElement('label', 'writing-template-slot-label', slot.name);
      const input = document.createElement(slot.value.length > 90 ? 'textarea' : 'input');
      if (input instanceof HTMLInputElement) input.type = 'text';
      input.value = slot.value;
      input.maxLength = 1000;
      input.placeholder = `填写“${slot.name}”`;
      input.dataset.writingTemplateSlot = question.id;
      input.dataset.slotIndex = String(index);
      label.append(input);
      field.append(label);
      slots.append(field);
    });
    builder.append(slots);
    const previewHeading = makeElement('p', 'writing-template-preview-heading', '实时成稿预览');
    const preview = makeElement('div', 'writing-template-preview', compileWritingTemplate(template, true));
    preview.dataset.writingTemplatePreview = question.id;
    builder.append(previewHeading, preview);
    const actions = makeElement('div', 'writing-template-actions');
    const clear = makeElement('button', '', '清除模板');
    clear.type = 'button';
    clear.dataset.clearWritingTemplate = question.id;
    const apply = makeElement('button', '', state.answers[question.id] ? '重新应用到作文' : '应用到作文');
    apply.type = 'button';
    apply.dataset.applyWritingTemplate = question.id;
    actions.append(clear, apply);
    builder.append(actions);
    return builder;
  }

  async function importWritingTemplate(questionId, file) {
    if (!file) return;
    const extension = String(file.name || '').toLowerCase().split('.').pop();
    if (!['txt', 'md'].includes(extension)) {
      showToast('模板仅支持 UTF-8 的 TXT 或 Markdown 文件');
      return;
    }
    if (file.size <= 0 || file.size > MAX_TEMPLATE_FILE_BYTES) {
      showToast('模板文件大小必须在 1B–64KB 之间');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (source.includes('\0')) throw new Error('binary template');
      if (source.length > MAX_TEMPLATE_SOURCE_CHARS) {
        showToast('模板正文不能超过 12,000 个字符');
        return;
      }
      const previous = state.writingTemplates[questionId]?.slots || [];
      const parsed = parseWritingTemplate(source, previous);
      if (!parsed.slots.length) {
        showToast('没有找到占位符，请使用 {{主题}} 这样的格式');
        return;
      }
      state.writingTemplates[questionId] = {
        version: 1,
        name: String(file.name || '写作模板.txt').slice(0, 160),
        source: parsed.source,
        slots: parsed.slots,
        updatedAt: Date.now(),
        lastAppliedAt: 0,
      };
      renderQuestionDetail();
      save();
      showToast(`已导入模板，共 ${parsed.slots.length} 个填空项`);
    } catch {
      showToast('模板不是有效的 UTF-8 纯文本文件');
    }
  }

  function applyWritingTemplate(questionId) {
    const template = state.writingTemplates[questionId];
    if (!template) return;
    const missingIndex = template.slots.findIndex((slot) => !String(slot.value || '').trim());
    if (missingIndex >= 0) {
      showToast(`请先填写“${template.slots[missingIndex].name}”`);
      $$('[data-writing-template-slot]', questionDetail)[missingIndex]?.focus();
      return;
    }
    const completed = compileWritingTemplate(template, false);
    if (completed.length > MAX_LONG_ANSWER_CHARS) {
      showToast(`模板成稿为 ${completed.length.toLocaleString('zh-CN')} 字符，超过 12,000 字符上限，请缩短填空内容`);
      return;
    }
    const existing = String(state.answers[questionId] || '').trim();
    if (existing && existing !== completed && !window.confirm('当前作文已有内容。确定使用模板成稿覆盖当前内容吗？')) return;
    template.lastAppliedAt = Date.now();
    const textarea = $('[data-long-answer]', questionDetail);
    if (textarea?.dataset.longAnswer === questionId) textarea.value = completed;
    setQuestionAnswer(questionId, completed, false);
    showToast('模板填空内容已应用到作文，可继续自由修改');
  }

  function updateLongAnswer(questionId, value) {
    const beforeAnswered = Boolean(String(state.answers[questionId] || '').trim());
    const answer = String(value || '').slice(0, MAX_LONG_ANSWER_CHARS);
    if (answer) state.answers[questionId] = answer;
    else delete state.answers[questionId];
    state.currentQuestionId = questionId;
    state.submitted = false;
    state.grade = null;
    const afterAnswered = Boolean(answer.trim());
    if (beforeAnswered !== afterAnswered) {
      renderAllPageQuestions();
      renderQuestionProgress();
      renderQuestionNavigator();
      renderExamResult();
    }
    save();
  }

  function renderQuestionDetail() {
    if (!questionDetail) return;
    questionDetail.replaceChildren();
    const question = currentQuestion();
    if (!question) return;
    const official = answerKey.get(question.id);
    const selected = String(state.answers[question.id] || '');
    const status = questionStatus(question);

    const header = makeElement('div', 'question-detail-header');
    const heading = makeElement('div');
    const kicker = makeElement('p', 'question-detail-kicker', `${question.section ? `${question.section} · ` : ''}第 ${question.page} 页`);
    const title = makeElement('h3', '', questionLabel(question));
    const flag = makeElement('button', 'question-flag-button', status.flagged ? '已标记' : '待复查');
    flag.type = 'button';
    flag.dataset.flagQuestion = question.id;
    flag.setAttribute('aria-pressed', String(status.flagged));
    heading.append(kicker, title);
    header.append(heading, flag);
    questionDetail.append(header);

    if (question.stem) questionDetail.append(makeElement('p', 'question-detail-stem', question.stem));
    if (question.objective) {
      const options = makeElement('div', 'question-detail-options');
      question.options.forEach((option) => {
        const label = makeElement('label', 'question-detail-option');
        label.dataset.detailQuestionOption = question.id;
        label.dataset.optionKey = option.key;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `question-${question.id}`;
        input.value = option.key;
        input.checked = selected.toUpperCase() === option.key;
        const key = makeElement('b', '', option.key);
        const text = makeElement('span', '', option.text || `选项 ${option.key}`);
        label.classList.toggle('is-selected', input.checked && !state.submitted);
        label.classList.toggle('is-correct', Boolean(state.submitted && official?.answer === option.key));
        label.classList.toggle('is-wrong', Boolean(state.submitted && input.checked && official?.answer !== option.key));
        label.append(input, key, text);
        options.append(label);
      });
      questionDetail.append(options);
    } else {
      if (/writing/.test(question.type)) questionDetail.append(renderWritingTemplateBuilder(question));
      const textarea = makeElement('textarea', 'question-long-answer');
      textarea.dataset.longAnswer = question.id;
      textarea.maxLength = MAX_LONG_ANSWER_CHARS;
      textarea.placeholder = '在这里输入写作、翻译或简答内容；答案会自动保存在当前浏览器。';
      textarea.value = selected;
      questionDetail.append(textarea);
    }

    appendConfidenceAndReview(questionDetail, question, official);
    if (state.submitted && official) {
      const explanation = official.explanation || `参考答案：${official.answer}`;
      const review = makeElement('p', 'answer-explanation', explanation);
      questionDetail.append(review);
    }
    const actions = makeElement('div', 'question-detail-actions');
    const locate = makeElement('button', '', '定位到试卷');
    locate.type = 'button';
    locate.dataset.locateQuestion = question.id;
    actions.append(locate);
    if (paperConfig.assistantUrl) {
      const askAi = makeElement('button', '', '询问本题 AI');
      askAi.type = 'button';
      askAi.dataset.askQuestionAi = question.id;
      actions.append(askAi);
    }
    questionDetail.append(actions);
  }

  function renderExamResult() {
    if (!examResult) return;
    examResult.replaceChildren();
    if (!state.grade) {
      examResult.hidden = true;
      return;
    }
    const accuracy = state.grade.total ? Math.round(state.grade.correct / state.grade.total * 100) : 0;
    const wrong = Number.isFinite(Number(state.grade.wrong))
      ? Number(state.grade.wrong)
      : Math.max(0, Number(state.grade.answered || 0) - Number(state.grade.correct || 0));
    const incomplete = Number.isFinite(Number(state.grade.incomplete))
      ? Number(state.grade.incomplete)
      : Math.max(0, Number(state.grade.total || 0) - Number(state.grade.answered || 0));
    const title = makeElement('strong', '', `正确率 ${accuracy}% · ${state.grade.correct}/${state.grade.total}`);
    const message = state.grade.total
      ? `正确 ${state.grade.correct} 题，错误 ${wrong} 题，未完成 ${incomplete} 题。${state.grade.ungraded ? `另有 ${state.grade.ungraded} 题没有可自动评分的答案。` : ''}`
      : '本卷暂时没有可以自动评分的客观题答案。';
    examResult.append(title, makeElement('p', '', message));
    const sectionParts = Object.values(state.grade.sections || {}).filter((section) => section.total).map((section) => (
      `${section.label} ${section.correct}/${section.total}`
    ));
    if (sectionParts.length) examResult.append(makeElement('p', '', sectionParts.join(' · ')));
    if (answerReviewSummary && typeof answerReviewSummary === 'object') {
      const reliable = Number(answerReviewSummary.reliable) || 0;
      const suggested = Number(answerReviewSummary.suggestedReview) || 0;
      const manual = Number(answerReviewSummary.manualReview) || 0;
      examResult.append(makeElement('p', '', `答案绑定：可靠 ${reliable} · 建议检查 ${suggested} · 人工确认 ${manual}`));
    }
    examResult.hidden = false;
  }

  function renderQuestionInterface() {
    if (!questions.length) return;
    if (!questions.some((question) => question.id === state.currentQuestionId)) state.currentQuestionId = questions[0].id;
    renderAllPageQuestions();
    renderQuestionProgress();
    renderQuestionNavigator();
    renderQuestionDetail();
    renderExamResult();
    if (aiQuestionPanel?.classList.contains('is-visible')) syncAiQuestionContext(state.currentQuestionId);
  }

  function setQuestionAnswer(questionId, value, rerenderDetail = true) {
    const question = questions.find((item) => item.id === questionId);
    if (!question) return;
    const answer = String(value || '').slice(0, MAX_LONG_ANSWER_CHARS);
    if (answer) state.answers[questionId] = answer;
    else delete state.answers[questionId];
    state.currentQuestionId = questionId;
    state.submitted = false;
    state.grade = null;
    renderAllPageQuestions();
    renderQuestionProgress();
    renderQuestionNavigator();
    renderExamResult();
    if (rerenderDetail) renderQuestionDetail();
    save();
  }

  function toggleQuestionFlag(questionId) {
    if (state.flagged.has(questionId)) state.flagged.delete(questionId);
    else state.flagged.add(questionId);
    state.currentQuestionId = questionId;
    renderQuestionInterface();
    save();
  }

  function closeQuestionPanel() {
    viewer.classList.remove('is-question-panel-open');
    $('#toggle-question-panel')?.setAttribute('aria-expanded', 'false');
    $('#question-panel-backdrop').hidden = true;
  }

  function openQuestionPanel() {
    if (!questionWorkspace || questionWorkspace.hidden) return;
    if (!matchMedia('(max-width: 900px)').matches) {
      state.notesPanel = true;
      updateToolbar();
      questionWorkspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
      save();
      return;
    }
    viewer.classList.add('is-question-panel-open');
    $('#toggle-question-panel')?.setAttribute('aria-expanded', 'true');
    $('#question-panel-backdrop').hidden = false;
  }

  function jumpToQuestion(questionId, smooth = true) {
    const question = questions.find((item) => item.id === questionId);
    if (!question) return;
    state.currentQuestionId = question.id;
    expandedQuestionId = question.id;
    renderQuestionInterface();
    jumpToPage(question.page, smooth);
    setTimeout(() => {
      const view = pageViews.get(question.page);
      const anchor = view && $$('[data-question-anchor]', view.questionLayer).find((element) => element.dataset.questionAnchor === question.id);
      anchor?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center', inline: 'nearest' });
      anchor?.querySelector('button')?.focus({ preventScroll: true });
    }, smooth ? 280 : 0);
    if (matchMedia('(max-width: 900px)').matches) closeQuestionPanel();
    save();
  }

  function configureExamAudio() {
    const player = $('#exam-audio-player');
    const container = $('#exam-audio');
    if (!player || !container) return;
    const audioUrl = resolveAssetUrl(manifest?.audioUrl);
    const reveal = () => {
      container.hidden = false;
      questionWorkspace.hidden = false;
      const toggle = $('#toggle-question-panel');
      toggle.hidden = false;
      if (!questions.length && toggle.firstChild) toggle.firstChild.textContent = '听力 ';
      $$('[data-question-only]', questionWorkspace).forEach((element) => { element.hidden = !questions.length; });
    };
    const hide = () => {
      container.hidden = true;
      player.removeAttribute('src');
      delete player.dataset.source;
    };
    if (!audioUrl) {
      hide();
      return;
    }
    if (player.dataset.source === audioUrl) return;
    player.dataset.source = audioUrl;
    player.addEventListener('error', hide, { once: true });
    player.src = audioUrl;
    reveal();
  }

  async function loadQuestionData() {
    if (!paperConfig.questionsUrl) return;
    try {
      const response = await fetch(paperConfig.questionsUrl, { headers: { Accept: 'application/json' } });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`questions request failed: ${response.status}`);
      const payload = await response.json();
      const version = reviewVersionFromResponse(response, payload);
      questionDataRevision = version.revision;
      questionDataEtag = version.etag;
      if (
        questionDataRevision !== null
        && state.aiHistoryRevision !== questionDataRevision
      ) {
        const hadHistory = Object.values(state.aiHistory).some((messages) => Array.isArray(messages) && messages.length);
        state.aiHistory = {};
        state.aiHistoryRevision = questionDataRevision;
        aiQuestionDrafts.clear();
        save();
        if (hadHistory) showToast('解析复核版本已更新，旧版本的 AI 对话已清除');
      }
      if (
        state.submitted
        && questionDataRevision !== null
        && state.grade?.reviewRevision !== questionDataRevision
      ) {
        state.submitted = false;
        state.grade = null;
        save();
        showToast('解析复核版本已更新，旧批改结果已清除，请重新交卷');
      }
      questions = normalizeQuestionsPayload(payload).map((question) => ({
        ...question,
        page: clamp(question.page, 1, manifest.pageCount),
      }));
      if (!questions.length) {
        configureExamAudio();
        return;
      }
      const validIds = new Set(questions.map((question) => question.id));
      state.flagged = new Set([...state.flagged].filter((id) => validIds.has(id)));
      if (!validIds.has(state.currentQuestionId)) state.currentQuestionId = questions[0].id;
      questionWorkspace.hidden = false;
      $('#toggle-question-panel').hidden = false;
      if ($('#toggle-question-panel').firstChild) $('#toggle-question-panel').firstChild.textContent = '答题 ';
      $$('[data-question-only]', questionWorkspace).forEach((element) => { element.hidden = false; });
      applyScale();
      renderQuestionInterface();
      $$('.thumbnail-button').forEach((button) => {
        const pageNumber = Number(button.dataset.thumbnailPage);
        const pageQuestions = questions.filter((question) => question.page === pageNumber);
        const label = $('.thumbnail-meta small', button);
        if (label && pageQuestions.length) label.textContent = `题 ${pageQuestions[0].number}${pageQuestions.length > 1 ? `–${pageQuestions[pageQuestions.length - 1].number}` : ''}`;
      });
      if (state.submitted && paperConfig.answersUrl) {
        fetch(paperConfig.answersUrl, { headers: versionedDocumentHeaders() }).then((answerResponse) => {
          if (answerResponse.status === 412) throw Object.assign(new Error('review revision changed'), { revisionChanged: true });
          if (!answerResponse.ok) throw new Error(`answers request failed: ${answerResponse.status}`);
          return answerResponse.json();
        }).then((payload) => {
          answerKey = normalizeAnswerKey(payload);
          renderQuestionInterface();
        }).catch((error) => {
          if (error?.revisionChanged) {
            showToast('解析复核版本已更新，请刷新后重新查看批改结果');
          }
          console.warn('Stored grading details unavailable:', error);
        });
      }
    } catch (error) {
      if ($('#exam-audio')?.hidden !== false) {
        questionWorkspace.hidden = true;
        $('#toggle-question-panel').hidden = true;
      }
      console.warn('Question layer unavailable:', error);
    }
  }

  async function submitObjectiveAnswers() {
    if (!questions.length || !paperConfig.answersUrl) return;
    submitExamButton.disabled = true;
    submitExamButton.textContent = '正在读取本卷答案…';
    try {
      const response = await fetch(paperConfig.answersUrl, { headers: versionedDocumentHeaders() });
      if (response.status === 412) {
        state.submitted = false;
        state.grade = null;
        save();
        showToast('解析复核版本已更新，正在重新载入题目；请确认后再次交卷');
        await loadQuestionData();
        return;
      }
      if (!response.ok) throw new Error(`answers request failed: ${response.status}`);
      answerKey = normalizeAnswerKey(await response.json());
      const objectiveQuestions = questions.filter((question) => question.objective && answerKey.has(question.id));
      const correct = objectiveQuestions.filter((question) => (
        String(state.answers[question.id] || '').trim().toUpperCase() === answerKey.get(question.id).answer
      )).length;
      const answered = objectiveQuestions.filter((question) => String(state.answers[question.id] || '').trim()).length;
      const summarize = (items, label) => {
        const sectionAnswered = items.filter((question) => String(state.answers[question.id] || '').trim()).length;
        const sectionCorrect = items.filter((question) => (
          String(state.answers[question.id] || '').trim().toUpperCase() === answerKey.get(question.id).answer
        )).length;
        return { label, total: items.length, answered: sectionAnswered, correct: sectionCorrect };
      };
      const listeningQuestions = objectiveQuestions.filter((question) => {
        const number = Number(question.number);
        return Number.isFinite(number) && number >= 1 && number <= 25;
      });
      const readingQuestions = objectiveQuestions.filter((question) => {
        const number = Number(question.number);
        return Number.isFinite(number) && number >= 26 && number <= 55;
      });
      state.submitted = true;
      state.grade = {
        correct,
        answered,
        total: objectiveQuestions.length,
        wrong: Math.max(0, answered - correct),
        incomplete: Math.max(0, objectiveQuestions.length - answered),
        sections: {
          listening: summarize(listeningQuestions, '听力'),
          reading: summarize(readingQuestions, '阅读'),
        },
        ungraded: questions.filter((question) => question.objective && !answerKey.has(question.id)).length,
        reviewRevision: questionDataRevision,
        submittedAt: Date.now(),
      };
      renderQuestionInterface();
      save();
      showToast(objectiveQuestions.length ? `评分完成：${correct}/${objectiveQuestions.length}` : '答案文件中没有可自动评分的客观题');
    } catch (error) {
      showToast('暂时无法读取本卷答案，未进行评分');
      console.warn('Answer grading unavailable:', error);
    } finally {
      submitExamButton.disabled = false;
      submitExamButton.textContent = state.submitted ? '重新读取答案并评分' : '提交客观题并评分';
    }
  }

  const AI_SOURCE_BADGES = {
    official: { label: '含官方解析', className: 'ai-source-chip--official' },
    ai: { label: 'AI 辅助分析', className: 'ai-source-chip--ai' },
  };

  function extractReplyText(content) {
    const raw = String(content ?? '');
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return raw;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return parsed.reply.trim();
      }
    } catch { /* plain text content is fine */ }
    return raw;
  }

  function appendInlineMarkdown(parent, text) {
    // Whitelist inline syntax (**bold**, *em*, `code`) built entirely with
    // textContent nodes - model output never reaches innerHTML.
    const pattern = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[1] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        parent.append(strong);
      } else if (match[2] !== undefined) {
        const em = document.createElement('em');
        em.textContent = match[2];
        parent.append(em);
      } else {
        const code = document.createElement('code');
        code.textContent = match[3];
        parent.append(code);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function renderAssistantMarkdown(markdownText) {
    const container = document.createElement('div');
    container.className = 'ai-md';
    const lines = String(markdownText ?? '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let listNode = null;
    let quoteNode = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      paragraph.forEach((line, index) => {
        if (index) p.append(document.createTextNode(' '));
        appendInlineMarkdown(p, line);
      });
      container.append(p);
      paragraph = [];
    };
    const flushList = () => { listNode = null; };
    const flushQuote = () => { quoteNode = null; };
    lines.forEach((line) => {
      const trimmed = line.trim();
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
      const ordered = /^(\d{1,2})[.)]\s+(.*)$/.exec(trimmed);
      const quote = /^>\s?(.*)$/.exec(trimmed);
      if (!trimmed) { flushParagraph(); flushList(); flushQuote(); return; }
      if (heading) {
        flushParagraph(); flushList(); flushQuote();
        const level = Math.min(heading[1].length + 2, 5);
        const node = document.createElement(`h${level}`);
        appendInlineMarkdown(node, heading[2]);
        container.append(node);
        return;
      }
      if (bullet || ordered) {
        flushParagraph(); flushQuote();
        const wanted = bullet ? 'ul' : 'ol';
        if (!listNode || listNode.tagName.toLowerCase() !== wanted) {
          listNode = document.createElement(wanted);
          container.append(listNode);
        }
        const li = document.createElement('li');
        appendInlineMarkdown(li, (bullet ? bullet[1] : ordered[2]));
        listNode.append(li);
        return;
      }
      if (quote) {
        flushParagraph(); flushList();
        if (!quoteNode) {
          quoteNode = document.createElement('blockquote');
          container.append(quoteNode);
        }
        appendInlineMarkdown(quoteNode, quote[1]);
        return;
      }
      if (/^```/.test(trimmed)) { flushParagraph(); flushList(); flushQuote(); return; }
      paragraph.push(line);
    });
    flushParagraph();
    return container;
  }

  function assistantCitationText(citation) {
    const heading = [
      citation.label || citation.source || '资料证据',
      citation.questionId,
      citation.page ? `第 ${citation.page} 页` : '',
    ].filter(Boolean).join(' · ');
    return citation.quote ? `${heading}：${citation.quote}` : heading;
  }

  function appendAssistantMetadata(container, message) {
    const citations = normalizeAiCitations(message?.citations);
    if (citations.length) {
      const details = document.createElement('details');
      details.append(makeElement('summary', '', `资料依据（${citations.length}）`));
      const list = document.createElement('ul');
      citations.forEach((citation) => list.append(makeElement('li', '', assistantCitationText(citation))));
      details.append(list);
      container.append(details);
    }
    const generation = normalizeAiGeneration(message?.generation);
    if (generation && !message?.agent) {
      const details = document.createElement('details');
      details.append(makeElement('summary', '', '模型运行'));
      const list = document.createElement('ul');
      list.append(makeElement('li', '', `Provider：${generation.provider}`));
      list.append(makeElement('li', '', generation.used ? '已使用 DeepSeek 模型' : `未使用模型（${generation.fallbackReason || 'deterministic'}）`));
      if (generation.model) list.append(makeElement('li', '', `Model：${generation.model}`));
      if (generation.usage) {
        list.append(makeElement('li', '', `Tokens：输入 ${generation.usage.promptTokens ?? '-'} / 输出 ${generation.usage.completionTokens ?? '-'} / 共 ${generation.usage.totalTokens ?? '-'}`));
      }
      details.append(list);
      container.append(details);
    }
    const agent = normalizeAiAgent(message?.agent);
    if (!agent) return;
    const details = document.createElement('details');
    const summaryParts = ['Agent 运行'];
    if (agent.intent) summaryParts.push(agent.intent);
    if (agent.trace.durationMs !== null) summaryParts.push(`${agent.trace.durationMs} ms`);
    if (generation?.used) summaryParts.push(generation.model || 'model');
    details.append(makeElement('summary', '', summaryParts.join(' · ')));
    const list = document.createElement('ul');
    if (generation) {
      list.append(makeElement('li', '', `Provider：${generation.provider}${generation.model ? ` · Model：${generation.model}` : ''}`));
      list.append(makeElement('li', '', generation.used ? '本次回答由 DeepSeek 生成' : `使用确定性回退（${generation.fallbackReason || 'not_configured'}）`));
      if (generation.usage) {
        list.append(makeElement('li', '', `Tokens：输入 ${generation.usage.promptTokens ?? '-'} / 输出 ${generation.usage.completionTokens ?? '-'} / 共 ${generation.usage.totalTokens ?? '-'}`));
      }
    }
    if (agent.runId) list.append(makeElement('li', '', `Run ID：${agent.runId}`));
    agent.tools.forEach((tool) => {
      const status = tool.status ? `（${tool.status}）` : '';
      const summary = tool.summary ? ` — ${tool.summary}` : '';
      list.append(makeElement('li', '', `工具：${tool.name}${status}${summary}`));
    });
    agent.trace.nodes.forEach((node) => list.append(makeElement('li', '', `节点：${node}`)));
    details.append(list);
    container.append(details);
  }

  function activeAiThread() {
    if (aiScope === 'general') return state.aiFreeHistory;
    if (aiScope === 'selection') return state.aiSelectionHistory;
    const questionId = aiPanelQuestionId || state.currentQuestionId;
    if (!Array.isArray(state.aiHistory[questionId])) state.aiHistory[questionId] = [];
    return state.aiHistory[questionId];
  }

  function renderAiConversation(pending = false) {
    if (!aiQuestionMessages) return;
    aiQuestionMessages.replaceChildren();
    const history = activeAiThread();
    if (!history.length) {
      const hints = {
        question: '可以问我选项辨析、原文证据或解题思路。回答会以当前题和你的作答为上下文。',
        general: '自由提问模式：语法、词汇、翻译、写作方法都可以直接问，与题目互不影响。',
        selection: '选中文本模式：先在试卷上选中一段文字，再针对它提问（翻译 / 长难句 / 词汇）。',
      };
      aiQuestionMessages.append(makeElement('p', 'ai-question-message', hints[aiScope] || hints.question));
    }
    history.forEach((message, index) => {
      const isUser = message.role === 'user';
      const container = makeElement('article', `ai-question-message${isUser ? ' ai-question-message--user' : ''}`);
      if (!isUser) {
        const badge = AI_SOURCE_BADGES[message.sourceBadge];
        if (badge) {
          container.append(makeElement('span', `ai-source-chip ${badge.className}`, badge.label));
        }
        const bodyWrapper = document.createElement('div');
        bodyWrapper.className = 'ai-md-body';
        bodyWrapper.append(renderAssistantMarkdown(extractReplyText(message.content)));
        container.append(bodyWrapper);
        appendAssistantMetadata(container, { ...message, role: 'assistant' });
        const copyButton = makeElement('button', 'ai-copy-message-button', '复制');
        copyButton.type = 'button';
        copyButton.setAttribute('aria-label', `复制第 ${index + 1} 条 AI 回复`);
        copyButton.addEventListener('click', async () => {
          const copied = await copyTextWithFallback(extractReplyText(message.content));
          showToast(copied ? '已复制该条回复' : '浏览器未授权复制');
        });
        container.append(copyButton);
      } else {
        container.append(makeElement('div', '', message.content));
      }
      aiQuestionMessages.append(container);
    });
    if (pending) aiQuestionMessages.append(makeElement('p', 'ai-question-message is-pending', '正在结合上下文整理回答…'));
    aiQuestionMessages.scrollTop = aiQuestionMessages.scrollHeight;
  }

  function renderAiQuestionMessages(questionId, pending = false) {
    return renderAiConversation(pending);
  }

  const AI_QUICK_PROMPTS = {
    question: ['为什么不能选 A？', '解释正确答案', '分析我的错误', '翻译题目', '总结解题技巧'],
    writing: ['生成写作提纲', '给出开头示例', '检查语法', '优化表达'],
    general: ['制定四周备考计划', '长难句分析方法', '高频词汇记忆技巧'],
    selection: ['翻译这段内容', '解释长难句', '分析语法结构', '提取重点词汇', '总结段落'],
  };

  function quickPromptsForScope() {
    if (aiScope !== 'question') return AI_QUICK_PROMPTS[aiScope];
    const question = questions.find((item) => item.id === aiPanelQuestionId) || currentQuestion();
    return /writing/.test(question?.type || '') ? AI_QUICK_PROMPTS.writing : AI_QUICK_PROMPTS.question;
  }

  function renderQuickPrompts() {
    const container = $('#ai-quick-prompts');
    if (!container) return;
    container.replaceChildren();
    quickPromptsForScope().forEach((promptText) => {
      const button = makeElement('button', 'ai-quick-prompt', promptText);
      button.type = 'button';
      button.title = `快捷提问：${promptText}`;
      button.addEventListener('click', () => {
        if (aiChatBusy) return;
        const input = $('#ai-question-input');
        if (!input) return;
        input.value = promptText;
        $('#ai-question-form')?.requestSubmit();
      });
      container.append(button);
    });
  }

  function capturePdfSelectionText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
    const text = selection.toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 8000);
  }

  function setAiScope(scope, { silent = false, rerender = true } = {}) {
    if (!['general', 'question', 'selection'].includes(scope)) return;
    if (scope === 'question' && !questions.length) {
      if (!silent) showToast('当前试卷还没有题目，请先使用自由提问');
      return;
    }
    if (scope === 'selection') {
      const captured = capturePdfSelectionText();
      if (!captured) {
        if (!silent) showToast('请先在试卷上选中一段文字，再切换到选中文本模式');
        return;
      }
      aiSelectionText = captured;
    }
    aiScope = scope;
    refreshAiScopeUi(rerender);
    if (!silent) {
      const labels = { general: '已切换到自由提问', question: '已切换到当前题目模式', selection: `已引用选中的 ${aiSelectionText.length} 字` };
      showToast(labels[scope]);
    }
  }

  function refreshAiScopeUi(rerender = true) {
    $$('.ai-scope-switcher [data-ai-scope]').forEach((button) => {
      const active = button.dataset.aiScope === aiScope;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('is-active', active);
    });
    const title = $('#ai-question-title');
    const context = $('#ai-question-context');
    const label = $('#ai-input-label');
    const question = questions.find((item) => item.id === aiPanelQuestionId) || currentQuestion();
    if (title) {
      title.textContent = { general: 'AI 学习助手 · 自由提问', selection: 'AI 学习助手 · 选中文本', question: `本题 AI 助手${question ? ` · ${questionLabel(question)}` : ''}` }[aiScope];
    }
    if (context) {
      context.textContent = {
        general: '与试卷无关的英语问题都可以直接问；不会读取答案资料。',
        question: question
          ? `${questionLabel(question)} · ${String(question.stem || '').slice(0, 80)}`
          : '先从题号导航选择一道题。',
        selection: `将引用选中的 ${aiSelectionText.length} 个字符作为上下文。`,
      }[aiScope];
    }
    if (label) {
      label.textContent = {
        general: '向 AI 提问（Enter 发送，Shift+Enter 换行）',
        selection: '针对选中文本提问（Enter 发送，Shift+Enter 换行）',
        question: '针对当前题提问（Enter 发送，Shift+Enter 换行）',
      }[aiScope];
    }
    renderQuickPrompts();
    if (rerender) renderAiConversation();
  }

  function syncAiQuestionContext(questionId = state.currentQuestionId) {
    const question = questions.find((item) => item.id === questionId) || currentQuestion();
    const formButton = $('#ai-question-form button');
    const input = $('#ai-question-input');
    const previousQuestionId = aiPanelQuestionId;
    if (input && previousQuestionId && previousQuestionId !== question?.id) {
      aiQuestionDrafts.set(previousQuestionId, input.value.slice(0, 2000));
    }
    if (!question) {
      aiPanelQuestionId = '';
      if (aiScope === 'question') setAiScope('general', { silent: true, rerender: false });
      refreshAiScopeUi();
      renderAiConversation();
      if (formButton) formButton.disabled = aiChatBusy;
      return;
    }
    aiPanelQuestionId = question.id;
    if (input && previousQuestionId !== question.id) input.value = aiQuestionDrafts.get(question.id) || '';
    if (aiScope === 'question') {
      $('#ai-question-title').textContent = `本题 AI 助手 · ${questionLabel(question)}`;
      $('#ai-question-context').textContent = question.stem || questionLabel(question);
      $('#ai-input-label') && ($('#ai-input-label').textContent = '针对当前题提问（Enter 发送，Shift+Enter 换行）');
    }
    const pending = assistantPendingQuestions.has(question.id);
    if (formButton) formButton.disabled = pending;
    renderAiQuestionMessages(question.id, pending);
    if (aiScope === 'question') renderQuickPrompts();
  }

  function openAiQuestionPanel(questionId = state.currentQuestionId) {
    if (!paperConfig.assistantUrl) {
      showToast('当前试卷未启用 AI 助手');
      return;
    }
    const question = questions.find((item) => item.id === questionId) || currentQuestion();
    if (question) state.currentQuestionId = question.id;
    else setAiScope('general', { silent: true, rerender: false });
    aiQuestionPanel.classList.add('is-visible');
    aiQuestionPanel.classList.remove('is-minimized');
    aiQuestionPanel.setAttribute('aria-hidden', 'false');
    $('#minimize-ai-question')?.setAttribute('aria-expanded', 'true');
    $('#ai-floating-launcher')?.setAttribute('aria-expanded', 'true');
    $('#ai-panel-backdrop').hidden = false;
    refreshAiScopeUi();
    renderAiConversation();
    $('#ai-question-input')?.focus();
    if (question) syncAiQuestionContext(question.id);
    save();
  }

  function closeAiQuestionPanel() {
    const input = $('#ai-question-input');
    if (input && aiPanelQuestionId) aiQuestionDrafts.set(aiPanelQuestionId, input.value.slice(0, 2000));
    aiQuestionPanel?.classList.remove('is-visible');
    aiQuestionPanel?.classList.remove('is-minimized');
    aiQuestionPanel?.setAttribute('aria-hidden', 'true');
    $('#ai-floating-launcher')?.setAttribute('aria-expanded', 'false');
    $('#ai-panel-backdrop').hidden = true;
    $('#ai-floating-launcher')?.focus({ preventScroll: true });
  }

  function toggleAiQuestionMinimized() {
    if (!aiQuestionPanel?.classList.contains('is-visible')) return;
    const minimized = aiQuestionPanel.classList.toggle('is-minimized');
    $('#minimize-ai-question')?.setAttribute('aria-expanded', String(!minimized));
    $('#minimize-ai-question')?.setAttribute('aria-label', minimized ? '展开 AI 助手' : '最小化 AI 助手');
    if (!minimized) $('#ai-question-input')?.focus();
  }

  function aiHistoryForRequest() {
    return activeAiThread().slice(-12).map(({ role, content }) => ({ role, content }));
  }

  function aiSourceBadgeFromResponse(data) {
    const grounding = data?.grounding;
    if (data?.scope && data.scope !== 'question') return null;
    if (grounding?.officialExplanationFound === true) return 'official';
    if (grounding?.disclaimerRequired === true || grounding?.officialExplanationFound === false) return 'ai';
    return null;
  }

  async function sendAiQuestion(message) {
    const question = questions.find((item) => item.id === aiPanelQuestionId);
    const cleanMessage = String(message || '').trim().slice(0, 2000);
    if (!cleanMessage || aiChatBusy) return;
    if (aiScope === 'question') {
      if (!question || !paperConfig.assistantUrl || assistantPendingQuestions.has(question.id)) return;
    }
    if (aiScope === 'selection' && !aiSelectionText.trim()) {
      showToast('请先在试卷上选中一段文字');
      setAiScope('general', { silent: true });
      return;
    }

    const requestIdBase = ++assistantRequestId;
    const requestScope = aiScope;
    const requestQuestionId = requestScope === 'question' ? question.id : '';
    const thread = activeAiThread();
    thread.push({ role: 'user', content: cleanMessage });
    if (thread.length > 24) thread.splice(0, thread.length - 24);
    aiLastFailure = null;
    $('#ai-retry-last').hidden = true;
    aiChatBusy = true;
    const sendButton = $('#ai-send-button');
    if (sendButton) sendButton.disabled = true;
    renderAiConversation(true);
    save();

    try {
      let body;
      if (requestScope === 'question') {
        body = { scope: 'question', questionId: question.id, message: cleanMessage, history: aiHistoryForRequest().slice(0, -1), requestId: `reader-${requestIdBase}` };
        const requestRevision = questionDataRevision;
        if (Number.isInteger(requestRevision) && requestRevision >= 0) {
          body.reviewRevision = requestRevision;
          body._requestRevision = requestRevision;
        }
        const userAnswer = String(state.answers[question.id] || '').trim();
        if (userAnswer) body.userAnswer = userAnswer.slice(0, 100);
      } else if (requestScope === 'selection') {
        body = { scope: 'selection', selectedText: aiSelectionText.slice(0, 8000), message: cleanMessage, history: aiHistoryForRequest().slice(0, -1), requestId: `reader-${requestIdBase}` };
      } else {
        body = { scope: 'general', message: cleanMessage, history: aiHistoryForRequest().slice(0, -1), requestId: `reader-${requestIdBase}` };
      }
      const expectedRevision = body._requestRevision;
      delete body._requestRevision;

      const response = await fetch(paperConfig.assistantUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 409 && requestScope === 'question') {
        throw Object.assign(new Error('review revision changed'), { revisionChanged: true });
      }
      if (!response.ok) throw new Error(`assistant request failed: ${response.status}`);
      const data = await response.json();
      if (
        requestScope === 'question'
        && Number.isInteger(expectedRevision)
        && Number.isInteger(data?.revision)
        && data.revision !== expectedRevision
      ) {
        throw Object.assign(new Error('assistant revision mismatch'), { revisionChanged: true });
      }
      if (requestScope === 'question' && expectedRevision !== questionDataRevision) {
        throw Object.assign(new Error('stale request'), { revisionChanged: true, staleRequest: true });
      }
      let reply = String(data?.reply ?? '').trim();
      if (!reply) throw new Error('empty assistant reply');
      const disclaimer = String(data?.grounding?.disclaimer || '').trim();
      if (disclaimer && !reply.includes(disclaimer)) reply = `${disclaimer}\n\n${reply}`;
      const assistantMessage = { role: 'assistant', content: reply.slice(0, 8000), requestId: requestIdBase };
      const badge = aiSourceBadgeFromResponse(data);
      if (badge) assistantMessage.sourceBadge = badge;
      const citations = normalizeAiCitations(data?.citations ?? data?.grounding?.citations);
      const agent = normalizeAiAgent(data?.agent);
      const generation = normalizeAiGeneration(data?.generation);
      if (citations.length) assistantMessage.citations = citations;
      if (agent) assistantMessage.agent = agent;
      if (generation) assistantMessage.generation = generation;
      activeAiThread().push(assistantMessage);
      if (activeAiThread().length > 24) activeAiThread().splice(0, activeAiThread().length - 24);
      aiLastFailure = null;
      $('#ai-retry-last').hidden = true;
    } catch (error) {
      if (error?.revisionChanged) {
        loadQuestionData();
        showToast('试卷解析已更新，请重新查看本题后再提问');
      } else {
        aiLastFailure = { scope: requestScope, questionId: requestQuestionId, message: cleanMessage };
        const retryButton = $('#ai-retry-last');
        if (retryButton) retryButton.hidden = false;
        showToast('AI 回复失败，可点击“重试”再试一次');
      }
      console.warn('AI chat request failed:', error);
    } finally {
      aiChatBusy = false;
      if (sendButton) sendButton.disabled = false;
      renderAiConversation(false);
      save();
    }
  }

  function pageAnnotations(pageNumber) {
    return state.annotations.filter((annotation) => annotation.page === pageNumber);
  }

  function renderPageAnnotations(pageNumber) {
    const view = pageViews.get(pageNumber);
    if (!view) return;
    view.markup.replaceChildren();
    view.badgeLayer.replaceChildren();
    pageAnnotations(pageNumber).forEach((annotation) => {
      if (annotation.type === 'line') {
        view.markup.append(createSvgElement('line', {
          x1: annotation.x1, y1: annotation.y1, x2: annotation.x2, y2: annotation.y2,
          stroke: annotation.color, 'stroke-width': annotation.width, class: 'mark-line',
        }));
        return;
      }
      annotation.rects.forEach((rect) => {
        view.markup.append(createSvgElement('rect', {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height, rx: annotation.type === 'tag' ? 1.4 : .8,
          class: annotation.type === 'highlight' ? 'mark-highlight' : `mark-tag-${annotation.tone}`,
          style: annotation.type === 'highlight' ? `--highlight-color:${annotation.color || '#f6d64a'}` : '',
        }));
      });
      if (annotation.type === 'tag') {
        const last = annotation.rects[annotation.rects.length - 1];
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = `page-tag-badge page-tag-badge--${annotation.tone}`;
        badge.dataset.pageTagId = annotation.id;
        badge.textContent = annotation.label;
        badge.title = annotation.note ? `${annotation.label}：${annotation.note}` : `编辑标签：${annotation.label}`;
        Object.assign(badge.style, {
          left: `${clamp(last.x + last.width + 2, 2, view.page.width - 82)}px`,
          top: `${clamp(last.y - 6, 2, view.page.height - 20)}px`,
        });
        view.badgeLayer.append(badge);
      }
    });
  }

  function renderAllAnnotations() {
    pageViews.forEach((_, pageNumber) => renderPageAnnotations(pageNumber));
    renderAnnotationPanel();
  }

  function renderAnnotationPanel() {
    const lines = state.annotations.filter((item) => item.type === 'line');
    const highlights = state.annotations.filter((item) => item.type === 'highlight');
    const tags = state.annotations.filter((item) => item.type === 'tag');
    $('#annotation-total').textContent = String(state.annotations.length);
    $('#line-count').textContent = String(lines.length);
    $('#highlight-count').textContent = String(highlights.length);
    $('#tag-count').textContent = String(tags.length);
    const list = $('#tag-record-list');
    list.replaceChildren();
    if (!tags.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-record';
      empty.textContent = '还没有标签。选择“查词 / 标签”后拖选试卷文字。';
      list.append(empty);
      return;
    }
    tags.slice().reverse().forEach((tag) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const header = document.createElement('header');
      const label = document.createElement('b');
      const page = document.createElement('small');
      const quote = document.createElement('p');
      button.type = 'button';
      button.className = 'tag-record-button';
      button.dataset.recordTagId = tag.id;
      label.textContent = tag.label;
      page.textContent = `第 ${tag.page} 页`;
      quote.textContent = tag.quote || '已选文字';
      header.append(label, page);
      button.append(header, quote);
      item.append(button);
      list.append(item);
    });
  }

  function pointOnPage(event, view) {
    const box = view.markup.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) * view.page.width / box.width, 0, view.page.width),
      y: clamp((event.clientY - box.top) * view.page.height / box.height, 0, view.page.height),
    };
  }

  function distanceToLine(point, line) {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    if (!dx && !dy) return Math.hypot(point.x - line.x1, point.y - line.y1);
    const amount = clamp(((point.x - line.x1) * dx + (point.y - line.y1) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(point.x - (line.x1 + amount * dx), point.y - (line.y1 + amount * dy));
  }

  function annotationHit(annotation, point) {
    if (annotation.type === 'line') return distanceToLine(point, annotation) <= Math.max(6, annotation.width + 4);
    return annotation.rects.some((rect) => (
      point.x >= rect.x - 5 && point.x <= rect.x + rect.width + 5
      && point.y >= rect.y - 5 && point.y <= rect.y + rect.height + 5
    ));
  }

  function eraseAt(event, view) {
    const point = pointOnPage(event, view);
    const removed = [];
    state.annotations = state.annotations.filter((annotation) => {
      if (annotation.page !== view.page.number || !annotationHit(annotation, point)) return true;
      if (!erasedDuringGesture.some((item) => item.id === annotation.id)) removed.push(cloneAnnotation(annotation));
      return false;
    });
    if (removed.length) {
      erasedDuringGesture.push(...removed);
      renderPageAnnotations(view.page.number);
      renderAnnotationPanel();
    }
  }

  function finishMarkupGesture(event, view) {
    if (!activePointer || event.pointerId !== activePointer.pointerId) return;
    if (activePointer.tool === 'line' && event.type !== 'pointercancel') {
      const end = pointOnPage(event, view);
      const length = Math.hypot(end.x - activePointer.start.x, end.y - activePointer.start.y);
      if (length >= 2) {
        const line = {
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'line', page: view.page.number,
          x1: activePointer.start.x, y1: activePointer.start.y, x2: end.x, y2: end.y,
          color: state.lineColor, width: 2.1, createdAt: Date.now(),
        };
        state.annotations.push(line);
        pushHistory({ kind: 'add', items: [cloneAnnotation(line)], label: '直线' });
        showToast('直线已保存');
      }
    } else if (erasedDuringGesture.length) {
      pushHistory({ kind: 'remove', items: erasedDuringGesture.map(cloneAnnotation), label: '擦除标注' });
      showToast(`已擦除 ${erasedDuringGesture.length} 项标注`);
    }
    try { view.markup.releasePointerCapture(event.pointerId); } catch { /* capture can already be released */ }
    activePointer = null;
    erasedDuringGesture = [];
    renderPageAnnotations(view.page.number);
    renderAnnotationPanel();
    save();
  }

  function attachMarkupEvents(view) {
    view.markup.addEventListener('pointerdown', (event) => {
      if (!['line', 'eraser'].includes(state.tool)) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      const start = pointOnPage(event, view);
      activePointer = { pointerId: event.pointerId, tool: state.tool, start, view };
      erasedDuringGesture = [];
      view.markup.setPointerCapture(event.pointerId);
      if (state.tool === 'eraser') eraseAt(event, view);
      else {
        const preview = createSvgElement('line', {
          x1: start.x, y1: start.y, x2: start.x, y2: start.y,
          stroke: state.lineColor, 'stroke-width': 2.1, class: 'mark-line mark-line-preview',
        });
        preview.dataset.preview = 'true';
        view.markup.append(preview);
      }
    });
    view.markup.addEventListener('pointermove', (event) => {
      if (!activePointer || event.pointerId !== activePointer.pointerId || activePointer.view !== view) return;
      event.preventDefault();
      if (activePointer.tool === 'eraser') eraseAt(event, view);
      else {
        const end = pointOnPage(event, view);
        const preview = $('[data-preview]', view.markup);
        preview?.setAttribute('x2', String(end.x));
        preview?.setAttribute('y2', String(end.y));
      }
    });
    view.markup.addEventListener('pointerup', (event) => finishMarkupGesture(event, view));
    view.markup.addEventListener('pointercancel', (event) => finishMarkupGesture(event, view));
  }

  function selectedWordsFromRange(range, pageNumber) {
    const view = pageViews.get(pageNumber);
    if (!view) return [];
    return $$('.pdf-word', view.textLayer).filter((word) => {
      try { return range.intersectsNode(word); }
      catch { return false; }
    });
  }

  function wordForSelectionNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest?.('.pdf-word') || null;
  }

  function pageForSelectionNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const scoped = element?.closest?.('.pdf-word, .page-text-layer');
    const page = Number(scoped?.dataset.page);
    return Number.isFinite(page) && page > 0 ? page : 0;
  }

  function rectanglesForWords(words) {
    const groups = new Map();
    words.forEach((word) => {
      const line = word.dataset.line;
      if (!groups.has(line)) groups.set(line, []);
      groups.get(line).push(word);
    });
    return [...groups.values()].map((lineWords) => {
      const boxes = lineWords.map((word) => ({
        x: Number(word.dataset.x), y: Number(word.dataset.y),
        width: Number(word.dataset.width), height: Number(word.dataset.height),
      }));
      const x = Math.min(...boxes.map((box) => box.x));
      const y = Math.min(...boxes.map((box) => box.y));
      const right = Math.max(...boxes.map((box) => box.x + box.width));
      const bottom = Math.max(...boxes.map((box) => box.y + box.height));
      return {
        x: Math.max(0, x - .8), y: Math.max(0, y - .5),
        width: right - x + 1.6, height: bottom - y + 1,
      };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  function closeSelectionCopyPanel({ restoreFocus = true } = {}) {
    pendingCopy = null;
    const panel = $('#selection-copy-panel');
    panel?.classList.remove('is-visible');
    panel?.setAttribute('aria-hidden', 'true');
    if (restoreFocus && copyPanelReturnFocus?.isConnected) copyPanelReturnFocus.focus({ preventScroll: true });
    copyPanelReturnFocus = null;
  }

  function openSelectionCopyPanel(text, page) {
    const panel = $('#selection-copy-panel');
    const textarea = $('#selection-copy-text');
    if (!panel || !textarea || !text) return;
    if (!panel.classList.contains('is-visible')) copyPanelReturnFocus = document.activeElement;
    pendingCopy = { text, page };
    textarea.value = text;
    $('#selection-copy-hint').textContent = `已选择 ${text.length.toLocaleString('zh-CN')} 个字符；点击复制后可粘贴到笔记。`;
    panel.classList.add('is-visible');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => $('#copy-selection-text')?.focus({ preventScroll: true }));
  }

  async function copyPendingSelection() {
    if (!pendingCopy?.text) return;
    const copied = await copyTextWithFallback(pendingCopy.text);
    if (copied) {
      const length = pendingCopy.text.length;
      closeSelectionCopyPanel();
      showToast(`已复制 ${length.toLocaleString('zh-CN')} 个字符`);
      return;
    }
    const textarea = $('#selection-copy-text');
    textarea?.focus();
    textarea?.select();
    $('#selection-copy-hint').textContent = '浏览器未授权自动复制，请按 Ctrl/Cmd+C；手机请长按上方文字复制。';
    showToast('自动复制未获授权，请手动复制所选文字');
  }

  function captureTextSelection() {
    if (!['select', 'copy', 'highlight'].includes(state.tool) || tagEditor?.contains(document.activeElement) || $('#selection-copy-panel')?.contains(document.activeElement)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    closeWordPopover();
    const range = selection.getRangeAt(0);
    const anchorWord = wordForSelectionNode(selection.anchorNode);
    const focusWord = wordForSelectionNode(selection.focusNode);
    const anchorPage = Number(anchorWord?.dataset.page) || pageForSelectionNode(selection.anchorNode);
    const focusPage = Number(focusWord?.dataset.page) || pageForSelectionNode(selection.focusNode);
    if (anchorPage && focusPage && anchorPage !== focusPage) {
      selection.removeAllRanges();
      showToast('请在同一页内选择文字');
      return;
    }
    let page = anchorPage || focusPage;
    let words = page ? selectedWordsFromRange(range, page) : [];
    if (!words.length) {
      const matches = [...pageViews.keys()].map((pageNumber) => ({ page: pageNumber, words: selectedWordsFromRange(range, pageNumber) })).filter((entry) => entry.words.length);
      if (matches.length > 1) {
        selection.removeAllRanges();
        showToast('请在同一页内选择文字');
        return;
      }
      page = matches[0]?.page || 0;
      words = matches[0]?.words || [];
    }
    if (!words.length) return;
    if (state.tool === 'copy') {
      const rawText = selection.toString().replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
      const fallbackText = words.map((word) => word.textContent.trim()).join(' ').replace(/\s+/g, ' ').trim();
      const fullText = rawText || fallbackText;
      const copyText = fullText.slice(0, 20000);
      selection.removeAllRanges();
      openSelectionCopyPanel(copyText, page);
      if (fullText.length > copyText.length) showToast('所选内容较长，本次复制保留前 20,000 个字符');
      return;
    }
    const rects = rectanglesForWords(words);
    const quote = words.map((word) => word.textContent.trim()).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const wordIds = words.map((word) => Number(word.dataset.wordId));
    const selectionBox = range.getBoundingClientRect();
    selection.removeAllRanges();
    if (state.tool === 'highlight') {
      const highlight = {
        id: `highlight-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'highlight', page, rects, quote, wordIds, color: state.highlightColor, createdAt: Date.now(),
      };
      state.annotations.push(highlight);
      pushHistory({ kind: 'add', items: [cloneAnnotation(highlight)], label: '矩形荧光标记' });
      renderPageAnnotations(page);
      renderAnnotationPanel();
      save();
      showToast(`已用 ${rects.length} 个规整矩形覆盖所选文字`);
      return;
    }
    pendingSelection = { page, rects, quote, wordIds, selectionBox };
    activeTag = null;
    openTagEditor();
  }

  function tagRectInViewport(tag) {
    const view = pageViews.get(tag.page);
    const first = tag.rects[0];
    if (!view || !first) return null;
    const box = view.surface.getBoundingClientRect();
    const scale = box.width / view.page.width;
    return {
      left: box.left + first.x * scale,
      right: box.left + (first.x + first.width) * scale,
      top: box.top + first.y * scale,
      bottom: box.top + (first.y + first.height) * scale,
      width: first.width * scale,
      height: first.height * scale,
    };
  }

  function setTagPreset(label, tone) {
    activeTagTone = tones.has(tone) ? tone : 'amber';
    tagLabelInput.value = label;
    $$('[data-tag-label]').forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.tagLabel === label && button.dataset.tagTone === activeTagTone));
    });
  }

  function positionTagEditor(box) {
    if (!box || !tagEditor) return;
    if (matchMedia('(max-width: 680px)').matches) {
      tagEditor.style.top = 'auto';
      return;
    }
    const width = tagEditor.offsetWidth;
    const height = tagEditor.offsetHeight;
    const left = clamp(box.left + box.width / 2 - width / 2, 12, Math.max(12, innerWidth - width - 12));
    const preferredTop = box.bottom + height + 12 > innerHeight ? box.top - height - 12 : box.bottom + 12;
    Object.assign(tagEditor.style, { left: `${left}px`, top: `${clamp(preferredTop, 12, Math.max(12, innerHeight - height - 12))}px` });
  }

  function openTagEditor() {
    const source = activeTag || pendingSelection;
    if (!source || !tagEditor) return;
    closeWordPopover();
    $('#selected-quote').textContent = `“${source.quote || '已选文字'}”`;
    setTagPreset(activeTag?.label || '重点', activeTag?.tone || 'amber');
    tagNoteInput.value = activeTag?.note || '';
    tagDeleteButton.hidden = !activeTag;
    tagEditor.classList.add('is-visible');
    tagEditor.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      positionTagEditor(activeTag ? tagRectInViewport(activeTag) : pendingSelection.selectionBox);
      tagLabelInput.focus();
      tagLabelInput.select();
    });
  }

  function closeTagEditor() {
    tagEditor?.classList.remove('is-visible');
    tagEditor?.setAttribute('aria-hidden', 'true');
    activeTag = null;
    pendingSelection = null;
  }

  function saveTag() {
    const source = activeTag || pendingSelection;
    const label = tagLabelInput.value.trim();
    if (!source || !label) {
      showToast('请填写标签名称');
      tagLabelInput.focus();
      return;
    }
    const next = {
      id: activeTag?.id || `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'tag', page: source.page,
      rects: source.rects.map((rect) => ({ ...rect })),
      quote: source.quote, wordIds: [...(source.wordIds || [])],
      label: label.slice(0, 16), note: tagNoteInput.value.trim().slice(0, 260), tone: activeTagTone,
      createdAt: activeTag?.createdAt || Date.now(),
    };
    if (activeTag) {
      const before = cloneAnnotation(activeTag);
      state.annotations = state.annotations.map((item) => item.id === next.id ? next : item);
      pushHistory({ kind: 'replace', before, after: cloneAnnotation(next), label: '修改标签' });
    } else {
      state.annotations.push(next);
      pushHistory({ kind: 'add', items: [cloneAnnotation(next)], label: '添加标签' });
    }
    closeTagEditor();
    renderPageAnnotations(next.page);
    renderAnnotationPanel();
    save();
    showToast(`已保存标签：${next.label}`);
  }

  function deleteTag() {
    if (!activeTag) return;
    const removed = cloneAnnotation(activeTag);
    state.annotations = state.annotations.filter((item) => item.id !== removed.id);
    pushHistory({ kind: 'remove', items: [removed], label: '删除标签' });
    closeTagEditor();
    renderPageAnnotations(removed.page);
    renderAnnotationPanel();
    save();
    showToast('标签已删除');
  }

  function openExistingTag(tag) {
    jumpToPage(tag.page, true);
    state.tool = 'select';
    updateToolbar();
    setTimeout(() => {
      activeTag = tag;
      pendingSelection = null;
      openTagEditor();
    }, 260);
  }

  function undo() {
    const action = state.history.pop();
    if (!action) return;
    const affectedPages = new Set();
    if (action.kind === 'add') {
      const ids = new Set(action.items.map((item) => item.id));
      action.items.forEach((item) => affectedPages.add(item.page));
      state.annotations = state.annotations.filter((item) => !ids.has(item.id));
    } else if (action.kind === 'remove') {
      action.items.forEach((item) => { state.annotations.push(cloneAnnotation(item)); affectedPages.add(item.page); });
    } else if (action.kind === 'replace') {
      state.annotations = state.annotations.map((item) => item.id === action.before.id ? cloneAnnotation(action.before) : item);
      affectedPages.add(action.before.page);
    }
    affectedPages.forEach(renderPageAnnotations);
    renderAnnotationPanel();
    updateToolbar();
    save();
    showToast(`已撤回：${action.label}`);
  }

  function setCurrentPage(pageNumber) {
    currentPage = clamp(pageNumber, 1, manifest?.pageCount || 1);
    const input = $('#current-page');
    if (input && document.activeElement !== input) input.value = String(currentPage);
    $('#previous-page').disabled = currentPage <= 1;
    $('#next-page').disabled = currentPage >= manifest.pageCount;
    $$('[data-thumbnail-page]').forEach((button) => button.classList.toggle('is-current', Number(button.dataset.thumbnailPage) === currentPage));
  }

  function jumpToPage(pageNumber, smooth = false) {
    const page = clamp(Number(pageNumber) || 1, 1, manifest?.pageCount || 1);
    const view = pageViews.get(page);
    if (!view) return;
    view.shell.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    setCurrentPage(page);
  }

  function updateCurrentPageFromScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const viewportBox = viewport.getBoundingClientRect();
      const targetY = viewportBox.top + viewportBox.height * .42;
      let nearestPage = currentPage;
      let nearestDistance = Infinity;
      pageViews.forEach(({ shell }, pageNumber) => {
        const box = shell.getBoundingClientRect();
        const point = clamp(targetY, box.top, box.bottom);
        const distance = Math.abs(targetY - point);
        if (distance < nearestDistance) { nearestDistance = distance; nearestPage = pageNumber; }
      });
      if (nearestPage !== currentPage) setCurrentPage(nearestPage);
    });
  }

  function setTool(tool) {
    if (!tools.has(tool)) return;
    state.tool = tool;
    closeTagEditor();
    closeSelectionCopyPanel();
    closeWordPopover();
    window.getSelection()?.removeAllRanges();
    updateToolbar();
    renderAllPageQuestions();
    save();
    const hint = {
      select: '单击查词并朗读；拖选一段文字记录标签',
      copy: '拖选 PDF 文字，再点击“复制文本”',
      line: '按下起点并拖动，松开得到笔直线段',
      highlight: '拖选文字后会自动生成规整矩形荧光覆盖',
      eraser: '按住并划过标注即可擦除',
    }[tool];
    showToast(hint);
  }

  async function initialize() {
    const aiLauncher = $('#ai-floating-launcher');
    if (aiLauncher) aiLauncher.hidden = !paperConfig.assistantUrl;
    try {
      const response = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
      const payload = await response.json();
      manifest = payload?.manifest && typeof payload.manifest === 'object' ? payload.manifest : payload;
      if (!manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error('manifest has no pages');
      manifest.pages = manifest.pages.map((page, index) => ({
        ...page,
        number: Math.max(1, Math.floor(Number(page.number) || index + 1)),
        width: Math.max(1, Number(page.width) || 595.276),
        height: Math.max(1, Number(page.height) || 841.89),
        words: Array.isArray(page.words) ? page.words : [],
      }));
      manifest.pageCount = Math.max(1, Number(manifest.pageCount) || manifest.pages.length);
      manifest.title = String(manifest.title || `试卷 ${paperId}`);
      viewer.dataset.paperId = paperId;
      $('#paper-title').textContent = manifest.title;
      document.title = `${manifest.title} · CET-4 Exam Viewer`;
      $('#page-count').textContent = String(manifest.pageCount);
      $('#sidebar-page-count').textContent = `${manifest.pageCount} 页`;
      $('#current-page').max = String(manifest.pageCount);
      const sourceUrl = manifest.source ? resolveAssetUrl(manifest.source) : paperConfig.sourceUrl;
      const download = $('#download-paper');
      if (sourceUrl) download.href = sourceUrl;
      else download.hidden = true;
      const loadingPreview = $('.viewer-loading-preview');
      if (loadingPreview && manifest.pages[0]?.image) {
        loadingPreview.src = resolveAssetUrl(manifest.pages[0].image);
        loadingPreview.alt = `${manifest.title}首页预览`;
      }
      manifest.pages.forEach((page) => { createPageView(page); createThumbnail(page); });
      applyScale();
      renderAllAnnotations();
      setCurrentPage(1);
      updateToolbar();
      $('#viewer-loading').hidden = true;
      configureExamAudio();
      loadQuestionData();
    } catch (error) {
      const loading = $('#viewer-loading');
      loading.innerHTML = '<p>完整试卷载入失败，请确认服务已启动后刷新页面。</p>';
      console.error(error);
    }
  }

  $$('.tool-button[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('#line-color')?.addEventListener('input', (event) => { state.lineColor = event.currentTarget.value; save(); });
  $('#highlight-color')?.addEventListener('input', (event) => {
    state.highlightColor = event.currentTarget.value;
    updateToolbar();
    save();
  });
  $('#undo-mark')?.addEventListener('click', undo);
  $('#previous-page')?.addEventListener('click', () => jumpToPage(currentPage - 1, true));
  $('#next-page')?.addEventListener('click', () => jumpToPage(currentPage + 1, true));
  $('#current-page')?.addEventListener('change', (event) => jumpToPage(event.currentTarget.value, true));
  $('#zoom-in')?.addEventListener('click', () => { state.zoom = clamp(Number((state.zoom + .15).toFixed(2)), .55, 1.9); applyScale(); save(); });
  $('#zoom-out')?.addEventListener('click', () => { state.zoom = clamp(Number((state.zoom - .15).toFixed(2)), .55, 1.9); applyScale(); save(); });
  $('#fit-width')?.addEventListener('click', () => { state.zoom = 1; applyScale(); save(); });
  $('#toggle-thumbnails')?.addEventListener('click', () => { state.thumbnails = !state.thumbnails; updateToolbar(); requestAnimationFrame(applyScale); save(); });
  $('#toggle-notes')?.addEventListener('click', () => { state.notesPanel = !state.notesPanel; updateToolbar(); requestAnimationFrame(applyScale); save(); });
  thumbnailList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-thumbnail-page]');
    if (button) jumpToPage(button.dataset.thumbnailPage, true);
  });
  document.addEventListener('pointerdown', () => { selectionPointerActive = true; }, { passive: true });
  document.addEventListener('pointerup', () => {
    selectionPointerActive = false;
    setTimeout(captureTextSelection, 0);
  });
  document.addEventListener('pointercancel', () => { selectionPointerActive = false; });
  document.addEventListener('selectionchange', () => {
    if (state.tool !== 'copy') return;
    clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => {
      if (!selectionPointerActive && !matchMedia('(pointer: coarse)').matches) captureTextSelection();
    }, 420);
  });
  pagesNode?.addEventListener('click', (event) => {
    const questionOption = event.target.closest('[data-question-option]');
    if (questionOption) {
      event.preventDefault();
      const question = questions.find((item) => item.id === questionOption.dataset.questionOption);
      questionFocusRequest = question ? {
        page: question.page,
        questionId: question.id,
        option: questionOption.dataset.optionKey,
      } : null;
      setQuestionAnswer(questionOption.dataset.questionOption, questionOption.dataset.optionKey);
      return;
    }
    const pageQuestionToggle = event.target.closest('[data-toggle-page-question]');
    if (pageQuestionToggle) {
      event.preventDefault();
      const questionId = pageQuestionToggle.getAttribute('data-toggle-page-question');
      const question = questions.find((item) => item.id === questionId);
      questionFocusRequest = question ? { page: question.page, questionId: question.id, option: '' } : null;
      expandedQuestionId = expandedQuestionId === questionId ? '' : questionId;
      state.currentQuestionId = questionId;
      renderQuestionInterface();
      save();
      return;
    }
    const questionControl = event.target.closest('[data-open-question], [data-question-id]');
    if (questionControl) {
      const questionId = questionControl.dataset.openQuestion || questionControl.dataset.questionId;
      state.currentQuestionId = questionId;
      renderQuestionInterface();
      if (matchMedia('(max-width: 900px)').matches) openQuestionPanel();
      save();
      return;
    }
    const badge = event.target.closest('[data-page-tag-id]');
    const tag = badge && state.annotations.find((item) => item.id === badge.dataset.pageTagId && item.type === 'tag');
    if (tag) {
      openExistingTag(tag);
      return;
    }
    const word = event.target.closest('.pdf-word');
    const selectedText = window.getSelection()?.toString().trim();
    if (word && state.tool === 'select' && !selectedText) {
      const value = cleanLookupWord(word.dataset.word || word.textContent);
      if (!value) return;
      event.preventDefault();
      openWordPopover(word, value);
    }
  });
  questionNavigator?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-navigate-question]');
    if (button) jumpToQuestion(button.dataset.navigateQuestion, true);
  });
  questionDetail?.addEventListener('change', (event) => {
    const templateFile = event.target.closest('[data-writing-template-file]');
    if (templateFile) {
      const file = templateFile.files?.[0];
      templateFile.value = '';
      importWritingTemplate(templateFile.dataset.writingTemplateFile, file);
      return;
    }
    const option = event.target.closest('input[type="radio"]')?.closest('[data-detail-question-option]');
    if (option) setQuestionAnswer(option.dataset.detailQuestionOption, option.dataset.optionKey);
  });
  questionDetail?.addEventListener('input', (event) => {
    const slotInput = event.target.closest('[data-writing-template-slot]');
    if (slotInput) {
      const template = state.writingTemplates[slotInput.dataset.writingTemplateSlot];
      const slot = template?.slots?.[Number(slotInput.dataset.slotIndex)];
      if (slot) {
        slot.value = slotInput.value.slice(0, 1000);
        template.updatedAt = Date.now();
        updateWritingTemplatePreview(slotInput.dataset.writingTemplateSlot);
        save();
      }
      return;
    }
    const textarea = event.target.closest('[data-long-answer]');
    if (textarea) updateLongAnswer(textarea.dataset.longAnswer, textarea.value);
  });
  questionDetail?.addEventListener('click', (event) => {
    const importTemplate = event.target.closest('[data-import-writing-template]');
    if (importTemplate) {
      const fileInput = $('[data-writing-template-file]', questionDetail);
      if (fileInput?.dataset.writingTemplateFile === importTemplate.dataset.importWritingTemplate) fileInput.click();
      return;
    }
    const applyTemplate = event.target.closest('[data-apply-writing-template]');
    if (applyTemplate) { applyWritingTemplate(applyTemplate.dataset.applyWritingTemplate); return; }
    const clearTemplate = event.target.closest('[data-clear-writing-template]');
    if (clearTemplate) {
      delete state.writingTemplates[clearTemplate.dataset.clearWritingTemplate];
      renderQuestionDetail();
      save();
      showToast('写作模板已清除，当前作文内容保持不变');
      return;
    }
    const flag = event.target.closest('[data-flag-question]');
    if (flag) { toggleQuestionFlag(flag.dataset.flagQuestion); return; }
    const locate = event.target.closest('[data-locate-question]');
    if (locate) { jumpToQuestion(locate.dataset.locateQuestion, true); return; }
    const askAi = event.target.closest('[data-ask-question-ai]');
    if (askAi) openAiQuestionPanel(askAi.dataset.askQuestionAi);
  });
  submitExamButton?.addEventListener('click', submitObjectiveAnswers);
  $('#exam-audio-speed')?.addEventListener('change', (event) => {
    const player = $('#exam-audio-player');
    const speed = clamp(Number(event.currentTarget.value) || 1, .5, 2);
    if (player) player.playbackRate = speed;
  });
  $('#toggle-question-panel')?.addEventListener('click', () => {
    if (viewer.classList.contains('is-question-panel-open')) closeQuestionPanel();
    else openQuestionPanel();
  });
  $('#close-question-panel')?.addEventListener('click', closeQuestionPanel);
  $('#question-panel-backdrop')?.addEventListener('click', closeQuestionPanel);
  $('#close-ai-question')?.addEventListener('click', closeAiQuestionPanel);
  $('#minimize-ai-question')?.addEventListener('click', toggleAiQuestionMinimized);
  $('#ai-floating-launcher')?.addEventListener('click', () => {
    if (!aiQuestionPanel?.classList.contains('is-visible')) {
      openAiQuestionPanel(state.currentQuestionId);
      return;
    }
    if (aiQuestionPanel.classList.contains('is-minimized')) toggleAiQuestionMinimized();
    else $('#ai-question-input')?.focus();
  });
  $('#ai-panel-backdrop')?.addEventListener('click', closeAiQuestionPanel);
  const aiQuestionInput = $('#ai-question-input');
  aiQuestionInput?.addEventListener('compositionstart', () => { aiCompositionActive = true; });
  aiQuestionInput?.addEventListener('compositionend', () => { aiCompositionActive = false; });
  aiQuestionInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // IME candidates confirm with Enter: keyCode 229 and isComposing both flag
    // that state, and Shift+Enter must keep inserting a normal newline.
    if (event.shiftKey || event.isComposing || aiCompositionActive || event.keyCode === 229) return;
    event.preventDefault();
    $('#ai-question-form')?.requestSubmit();
  });
  $('#ai-question-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (aiChatBusy) return;
    const input = $('#ai-question-input');
    const message = input?.value.trim();
    if (!message) {
      showToast('先输入问题再发送');
      return;
    }
    if (input) input.value = '';
    if (aiScope === 'question' && aiPanelQuestionId) aiQuestionDrafts.delete(aiPanelQuestionId);
    sendAiQuestion(message);
  });
  $('#ai-question-input')?.addEventListener('input', (event) => {
    if (aiScope === 'question' && aiPanelQuestionId) {
      aiQuestionDrafts.set(aiPanelQuestionId, event.currentTarget.value.slice(0, 2000));
    }
  });
  $$('.ai-scope-switcher [data-ai-scope]').forEach((button) => {
    button.addEventListener('click', () => setAiScope(button.dataset.aiScope));
  });
  $('#ai-new-chat')?.addEventListener('click', () => {
    activeAiThread().splice(0);
    aiLastFailure = null;
    $('#ai-retry-last').hidden = true;
    renderAiConversation();
    save();
    showToast('已开始新的对话（其他题目与模式的历史不受影响）');
  });
  $('#ai-copy-last')?.addEventListener('click', async () => {
    const thread = activeAiThread();
    for (let index = thread.length - 1; index >= 0; index -= 1) {
      if (thread[index].role === 'assistant') {
        const copied = await copyTextWithFallback(extractReplyText(thread[index].content));
        showToast(copied ? '已复制最近一条 AI 回复' : '浏览器未授权复制');
        return;
      }
    }
    showToast('当前对话还没有 AI 回复');
  });
  $('#ai-retry-last')?.addEventListener('click', () => {
    if (!aiLastFailure || aiChatBusy) return;
    setAiScope(aiLastFailure.scope, { silent: true });
    if (aiLastFailure.questionId) syncAiQuestionContext(aiLastFailure.questionId);
    renderAiConversation();
    sendAiQuestion(aiLastFailure.message);
  });
  $('#tag-record-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-record-tag-id]');
    const tag = button && state.annotations.find((item) => item.id === button.dataset.recordTagId && item.type === 'tag');
    if (tag) openExistingTag(tag);
  });
  $$('[data-tag-label]').forEach((button) => button.addEventListener('click', () => setTagPreset(button.dataset.tagLabel, button.dataset.tagTone)));
  tagLabelInput?.addEventListener('input', () => $$('[data-tag-label]').forEach((button) => button.setAttribute('aria-checked', 'false')));
  $('#save-tag')?.addEventListener('click', saveTag);
  $('#cancel-tag')?.addEventListener('click', closeTagEditor);
  tagDeleteButton?.addEventListener('click', deleteTag);
  $('#copy-selection-text')?.addEventListener('click', copyPendingSelection);
  $('#close-selection-copy')?.addEventListener('click', closeSelectionCopyPanel);
  $('[data-close-selection-copy]')?.addEventListener('click', closeSelectionCopyPanel);
  viewport?.addEventListener('scroll', () => {
    updateCurrentPageFromScroll();
  }, { passive: true });
  addEventListener('resize', () => {
    applyScale();
    if (activeTag) positionTagEditor(tagRectInViewport(activeTag));
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.closest('input, textarea')) {
      event.preventDefault(); undo(); return;
    }
    if (event.key === 'Escape') {
      if (tagEditor?.classList.contains('is-visible')) closeTagEditor();
      if ($('#selection-copy-panel')?.classList.contains('is-visible')) closeSelectionCopyPanel();
      closeWordPopover();
      if (aiQuestionPanel?.classList.contains('is-visible')) closeAiQuestionPanel();
      if (viewer.classList.contains('is-question-panel-open')) closeQuestionPanel();
    }
    if (event.key === 'PageDown' && !event.target.closest('input, textarea')) { event.preventDefault(); jumpToPage(currentPage + 1, true); }
    if (event.key === 'PageUp' && !event.target.closest('input, textarea')) { event.preventDefault(); jumpToPage(currentPage - 1, true); }
    if (event.key === 'Enter' && event.target === $('#current-page')) jumpToPage(event.target.value, true);
  });
  if ('ResizeObserver' in window && viewport) new ResizeObserver(applyScale).observe(viewport);

  initialize();
})();
