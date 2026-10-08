(() => {
  'use strict';

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const requestedPaperId = new URLSearchParams(location.search).get('paper') || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(requestedPaperId)) {
    location.replace('upload.html');
    return;
  }
  const paperId = requestedPaperId;
  const RETURN_QUESTION_ID = /^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/;
  const requestedQuestion = new URLSearchParams(location.search).get('question') || '';
  const requestedQuestionId = RETURN_QUESTION_ID.test(requestedQuestion) ? requestedQuestion : '';
  const requestedPage = new URLSearchParams(location.search).get('page') || '';
  const requestedPageNumber = /^[1-9][0-9]{0,2}$/.test(requestedPage) ? Number(requestedPage) : 0;
  const requestedNote = new URLSearchParams(location.search).get('note') || '';
  const requestedNoteId = requestedNote.length <= 160 && !requestedNote.includes('\0') ? requestedNote : '';
  const writingLibraryLink = $('#open-writing-library');
  if (writingLibraryLink) writingLibraryLink.href = writingTemplateUrl(requestedQuestionId);
  const translationLibraryLink = $('#open-translation-library');
  const uploadedApiRoot = `/api/exams/${encodeURIComponent(paperId)}`;
  const paperConfig = {
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
  const noteDraftKey = `${storageKey}:note-drafts`;
  const MAX_NOTE_CHARS = 6000;
  const tools = new Set(['select', 'copy', 'line', 'highlight', 'eraser']);
  const tones = new Set(['amber', 'blue', 'green', 'purple']);
  const QUESTION_RAIL_WIDTH = 152;
  const MODULE_ENTRY_OFFSET = 60;
  const MAX_TEMPLATE_FILE_BYTES = 64 * 1024;
  const MAX_TEMPLATE_SOURCE_CHARS = 12000;
  const MAX_LONG_ANSWER_CHARS = 12000;
  // Keep request limits aligned with the server; define them before restoring
  // saved threads so reloading an existing conversation is safe.
  const HISTORY_SEND_MAX = 12;
  const HISTORY_CONTENT_MAX = 4000;
  const THREAD_STORE_MAX = 24;
  const SELECTED_TEXT_MAX = 8000;
  const AI_REQUEST_MAX_BYTES = 48 * 1024;
  const viewer = $('#exam-viewer');
  const viewport = $('#document-viewport');
  const pagesNode = $('#document-pages');
  const thumbnailList = $('#thumbnail-list');
  const tagEditor = $('#tag-editor');
  const tagLabelInput = $('#tag-label');
  const tagNoteInput = $('#tag-note');
  const tagDeleteButton = $('#delete-tag');
  const selectionToolbar = $('#selection-toolbar');
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
      base.note = String(item.note || '').trim().slice(0, MAX_NOTE_CHARS);
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
      'upstream_insufficient_balance', 'upstream_request_error', 'upstream_response_truncated',
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
      execution: window.AgentChat.normalizeExecution(value.execution),
      memory: value.memory && value.memory.enabled === true ? { enabled: true, turns: Number.isInteger(value.memory.turns) && value.memory.turns >= 0 ? value.memory.turns : null, summaryPresent: value.memory.summaryPresent === true } : null,
    };
    return agent.runId || agent.intent || agent.tools.length || agent.trace.nodes.length || agent.trace.durationMs !== null
      ? agent
      : null;
  }

  function normalizeStoredHistory(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value).slice(-40).map(([questionId, messages]) => {
      const cleanMessages = normalizeStoredThread(messages);
      return [String(questionId), cleanMessages];
    });
    return Object.fromEntries(entries);
  }

  function normalizeStoredRevision(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function normalizeStoredThread(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-THREAD_STORE_MAX).flatMap((message) => {
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(message?.content || '').slice(0, 8000);
      if (!content.trim()) return [];
      const clean = { role, content };
      if (role === 'assistant') {
        const generation = normalizeAiGeneration(message?.generation);
        const citations = normalizeAiCitations(message?.citations);
        const agent = normalizeAiAgent(message?.agent);
        if (agent) clean.agent = agent;
        if (generation) clean.generation = generation;
        if (citations.length) clean.citations = citations;
        if (Array.isArray(message.learningCitations)) clean.learningCitations = message.learningCitations.slice(0, 12).filter((citation) => typeof citation?.title === 'string').map((citation) => ({ title: citation.title.slice(0, 160), kind: String(citation.kind || '').slice(0, 60), official: false }));
        if (message?.sourceBadge === 'official') clean.sourceBadge = 'official';
        else if (message?.sourceBadge === 'ai') clean.sourceBadge = 'ai';
      }
      return [clean];
    });
  }

  function parseWritingTemplate(source, previousSlots = []) {
    const text = String(source || '').replace(/\0/g, '').slice(0, MAX_TEMPLATE_SOURCE_CHARS);
    const previous = new Map((Array.isArray(previousSlots) ? previousSlots : []).map((slot) => [String(slot?.name || ''), slot]));
    const names = [];
    text.replace(/\{\{\s*([^{}\r\n]{1,80}?)\s*\}\}/g, (match, rawName) => {
      const name = String(rawName || '').trim();
      if (name && !names.includes(name) && names.length < 40) names.push(name);
      return match;
    });
    return {
      source: text,
      slots: names.map((name) => {
        const oldSlot = previous.get(name);
        return {
          name,
          value: String(oldSlot?.value || '').slice(0, 1000),
          type: ['word', 'sentence'].includes(oldSlot?.type) ? oldSlot.type
            : /句|段|sentence|paragraph/i.test(name) ? 'sentence' : 'word',
        };
      }),
    };
  }

  function normalizeStoredWritingTemplates(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const templates = {};
    Object.entries(value).slice(0, 10).forEach(([questionId, template]) => {
      if (!/^(?:writing-|q)\d{1,3}$/.test(questionId) || !template || typeof template !== 'object') return;
      const parsed = parseWritingTemplate(template.source, template.slots || template.values);
      if (!parsed.source) return;
      templates[questionId] = {
        version: 1,
        name: String(template.name || '写作模板.txt').slice(0, 160),
        libraryId: String(template.libraryId || '').slice(0, 128),
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
    aiConversations: window.AgentChat.normalizeConversations(stored.aiConversations),
    writingTemplates: normalizeStoredWritingTemplates(stored.writingTemplates),
    history: [],
    redoHistory: [],
  };
  let answerBaseline = { ...state.answers };
  const answerConflicts = new Set();

  function changedAnswerIds() {
    return [...new Set([...Object.keys(answerBaseline), ...Object.keys(state.answers)])]
      .filter((id) => (answerBaseline[id] || '') !== (state.answers[id] || ''));
  }

  function showAnswerConflict() {
    const panel = $('#answer-sync-conflict');
    if (panel) panel.hidden = !answerConflicts.size;
  }

  function syncWorkspaceAnswers() {
    try {
      const latest = window.LearningStore.readExam(paperId);
      const incoming = normalizeStoredAnswers(latest.answers);
      const dirtyIds = new Set(changedAnswerIds());
      const previous = { ...state.answers };
      const next = { ...incoming };
      dirtyIds.forEach((id) => {
        if ((incoming[id] || '') !== (answerBaseline[id] || '') && (incoming[id] || '') !== (state.answers[id] || '')) answerConflicts.add(id);
        if (state.answers[id]) next[id] = state.answers[id]; else delete next[id];
      });
      Object.keys({ ...answerBaseline, ...incoming }).forEach((id) => { if (!dirtyIds.has(id)) { if (incoming[id]) answerBaseline[id] = incoming[id]; else delete answerBaseline[id]; } });
      state.answers = next;
      if (JSON.stringify(previous) !== JSON.stringify(next)) { state.submitted = false; state.grade = null; }
      renderAllPageQuestions(); renderQuestionProgress(); renderQuestionNavigator(); renderExamResult();
      if (!document.activeElement?.matches('[data-long-answer]')) renderQuestionDetail();
      showAnswerConflict();
    } catch (_error) { showToast('其他页面的作答暂时无法读取，当前输入仍保留。'); }
  }

  const noteDrafts = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(noteDraftKey) || '[]');
      return (Array.isArray(saved) ? saved : []).flatMap((draft) => {
        const source = normalizeAnnotation({ ...draft, type: 'tag', id: draft?.key });
        if (!source) return [];
        return [{ ...source, key: source.id, tagId: String(draft.tagId || ''),
          label: String(draft.label ?? '重点').slice(0, 16),
          note: String(draft.note || '').slice(0, MAX_NOTE_CHARS),
          updatedAt: Number(draft.updatedAt) || source.createdAt }];
      });
    } catch { return []; }
  })();

  let manifest = null;
  let fitScale = 1;
  let appliedScale = null;
  let currentPage = 1;
  let pageNavigationTarget = null;
  let activePointer = null;
  let erasedDuringGesture = [];
  let pendingSelection = null;
  let selectionContext = null;
  let selectionRange = null;
  let noteDraftTimer = 0;
  let annotationIndexDirty = true;
  const annotationIndex = new Map();
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
  let aiActiveRequest = null;
  let aiRuntime = null;
  let aiResetBusy = false;
  const aiFailures = new Map();
  let aiPointerDownInsidePanel = false;
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

  function save(immediate = false) {
    const indicator = $('#save-indicator');
    indicator?.classList.remove('is-error');
    indicator?.classList.add('is-saving');
    if (indicator) indicator.lastChild.textContent = ' 保存中';
    clearTimeout(saveTimer);
    const persist = () => {
      try {
        const latest = window.LearningStore.readExam(paperId);
        const incoming = normalizeStoredAnswers(latest.answers);
        const changes = changedAnswerIds();
        const conflict = changes.filter((id) => (incoming[id] || '') !== (answerBaseline[id] || '') && (incoming[id] || '') !== (state.answers[id] || ''));
        conflict.forEach((id) => answerConflicts.add(id));
        showAnswerConflict();
        if (conflict.length) throw new Error('answer conflict');
        const mergedAnswers = { ...incoming };
        changes.forEach((id) => { if (state.answers[id]) mergedAnswers[id] = state.answers[id]; else delete mergedAnswers[id]; });
        if (JSON.stringify(incoming) !== JSON.stringify(answerBaseline)) { state.submitted = false; state.grade = null; }
        localStorage.setItem(storageKey, JSON.stringify({
          ...latest,
          tool: state.tool,
          zoom: state.zoom,
          lineColor: state.lineColor,
          highlightColor: state.highlightColor,
          annotations: state.annotations,
          thumbnails: state.thumbnails,
          notesPanel: state.notesPanel,
          answers: mergedAnswers,
          flagged: [...state.flagged],
          currentQuestionId: state.currentQuestionId,
          submitted: state.submitted,
          grade: state.grade,
          aiHistory: normalizeStoredHistory(state.aiHistory),
          aiHistoryRevision: state.aiHistoryRevision,
          aiFreeHistory: normalizeStoredThread(state.aiFreeHistory),
          aiSelectionHistory: normalizeStoredThread(state.aiSelectionHistory),
          aiConversations: state.aiConversations,
          writingTemplates: normalizeStoredWritingTemplates(state.writingTemplates),
        }));
        state.answers = mergedAnswers;
        answerBaseline = { ...mergedAnswers };
        indicator?.classList.remove('is-saving');
        if (indicator) indicator.lastChild.textContent = ' 已自动保存';
        return true;
      } catch {
        indicator?.classList.remove('is-saving');
        indicator?.classList.add('is-error');
        if (indicator) indicator.lastChild.textContent = ' 保存失败';
        showToast(answerConflicts.size ? '本题在其他窗口发生修改，已暂停覆盖。请在顶部选择保留哪一版。' : '本地资料无法写入，当前输入仍在页面中；请检查存储并备份');
        return false;
      }
    };
    if (immediate) return persist();
    else saveTimer = setTimeout(persist, 180);
  }

  window.addEventListener('pagehide', () => {
    rememberNoteDraft();
    persistNoteDrafts();
    save(true);
  });

  function pushHistory(action) {
    annotationIndexDirty = true;
    state.history.push(action);
    state.history = state.history.slice(-80);
    state.redoHistory = [];
    updateToolbar();
  }

  function pageModule(pageNumber) {
    return `试卷第 ${pageNumber} 页`;
  }

  function updateToolbar() {
    viewer.dataset.tool = state.tool;
    $$('.tool-button[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool)));
    const undo = $('#undo-mark');
    if (undo) undo.disabled = state.history.length === 0;
    const redo = $('#redo-mark');
    if (redo) redo.disabled = state.redoHistory.length === 0;
    const color = $('#line-color');
    if (color && color.value !== state.lineColor) color.value = state.lineColor;
    const highlightColor = $('#highlight-color');
    if (highlightColor && highlightColor.value !== state.highlightColor) highlightColor.value = state.highlightColor;
    const selectionColor = $('#selection-highlight-color');
    if (selectionColor && selectionColor.value !== state.highlightColor) selectionColor.value = state.highlightColor;
    viewer.style.setProperty('--active-highlight-color', state.highlightColor);
    viewer.classList.toggle('is-thumbnails-hidden', !state.thumbnails);
    viewer.classList.toggle('is-notes-hidden', !state.notesPanel);
    $('#toggle-thumbnails')?.setAttribute('aria-pressed', String(state.thumbnails));
    $('#toggle-notes')?.setAttribute('aria-pressed', String(state.notesPanel));
    const guide = $('#tool-guide');
    const guideText = {
      select: ['查词 / 选段笔记', '单击查词；拖选文字后可复制、高亮、记笔记或问 AI。'],
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
    const moduleEntryLayer = makeElement('nav', 'page-module-entry-layer');
    moduleEntryLayer.setAttribute('aria-label', `第 ${page.number} 页对应题型入口`);
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
    surface.append(image, markup, textLayer, badgeLayer, questionLayer, moduleEntryLayer, pageBadge);
    shell.append(surface);
    pagesNode.append(shell);

    const view = { page, shell, surface, image, markup, textLayer, badgeLayer, questionLayer, moduleEntryLayer, moduleHeadings: detectModuleHeadings(page) };
    pageViews.set(page.number, view);
    renderModuleEntries(view);
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
    const hasEntries = [...pageViews.values()].some((view) => view.moduleEntryLayer.childElementCount);
    const hasRail = questions.length > 0 || hasEntries;
    const widestPage = Math.max(...manifest.pages.map((page) => page.width));
    const fit = available / (widestPage + (hasRail ? QUESTION_RAIL_WIDTH * 2 : 0));
    // Reserve a readable module button plus the question-control column on
    // both sides, without making "fit width" overflow on narrow screens.
    const entryFit = hasEntries ? (available - 88) / (widestPage + 2 * (MODULE_ENTRY_OFFSET + 6)) : fit;
    return clamp(Math.min(fit, entryFit), .35, 1.36);
  }

  function applyScale() {
    if (!manifest) return;
    // Anchor the visible page position before changing dimensions. Browser
    // scroll anchoring is disabled here so it cannot fight this calculation.
    const viewportTop = viewport.getBoundingClientRect().top;
    const centerY = viewportTop + viewport.clientHeight / 2;
    let anchor = null;
    if (appliedScale !== null) {
      let nearestDistance = Infinity;
      pageViews.forEach((view) => {
        const rect = view.surface.getBoundingClientRect();
        if (!rect.height) return;
        const pointY = clamp(centerY, rect.top, rect.bottom);
        const distance = Math.abs(pointY - centerY);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          anchor = { view, ratio: (pointY - rect.top) / rect.height, screenY: pointY - viewportTop };
        }
      });
    }
    fitScale = calculateFitScale();
    const totalScale = fitScale * state.zoom;
    const hasModuleEntries = [...pageViews.values()].some((view) => view.moduleEntryLayer.childElementCount);
    const hasRail = questions.length > 0 || hasModuleEntries;
    const railWidth = hasRail ? Math.max(QUESTION_RAIL_WIDTH, hasModuleEntries ? 44 / totalScale + MODULE_ENTRY_OFFSET + 6 : 0) : 0;
    pageViews.forEach((view) => {
      const { page, shell, surface } = view;
      // Center the original PDF, not the PDF plus a one-sided question rail.
      shell.style.width = `${(page.width + railWidth * 2) * totalScale}px`;
      shell.style.height = `${page.height * totalScale}px`;
      surface.style.left = `${railWidth * totalScale}px`;
      surface.style.top = '0px';
      surface.style.transform = `scale(${totalScale})`;
      sizeModuleEntries(view, totalScale, railWidth);
    });
    appliedScale = totalScale;
    // Keep overflow scrollable in both directions while showing its midpoint
    // after zoom or viewport changes. Manual panning remains available.
    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
    if (anchor) {
      const rect = anchor.view.surface.getBoundingClientRect();
      viewport.scrollTop += rect.top + rect.height * anchor.ratio - viewportTop - anchor.screenY;
    }
    const zoom = $('#zoom-value');
    if (zoom) zoom.textContent = state.zoom === 1 ? '适合宽度' : `${Math.round(state.zoom * 100)}%`;
  }

  function makeElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = text;
    return element;
  }

  function moduleWorkspaceUrl(module, questionId = '', pageNumber = 0) {
    const params = new URLSearchParams({ paper: paperId });
    if (RETURN_QUESTION_ID.test(questionId)) params.set('question', questionId);
    if (Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber < 1000) params.set('page', String(pageNumber));
    return `${module === 'translation' ? 'translation' : 'writing'}.html?${params}`;
  }

  function writingTemplateUrl(questionId = '', pageNumber = 0) {
    return moduleWorkspaceUrl('writing', questionId, pageNumber);
  }

  function detectModuleHeadings(page) {
    const lines = new Map();
    (page.words || []).forEach((word) => {
      if (!Number.isFinite(Number(word.x)) || !Number.isFinite(Number(word.y)) || Number(word.y) < 0 || Number(word.y) >= page.height) return;
      const key = word.line !== undefined && word.line !== null ? String(word.line) : `y:${Math.round(Number(word.y) / 3)}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(word);
    });
    const headings = [];
    lines.forEach((words) => {
      const text = words.sort((a, b) => Number(a.x) - Number(b.x)).map((word) => String(word.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
      const match = /^(?:(?:part|section)\s*[ivx\d]+\s*[-:.)]?\s*)?(writing|translation|写作|作文|翻译)(?:\s*[\[(（]\s*\d{1,3}\s*(?:minutes?|mins?|分钟)\s*[\])）])?\s*$/i.exec(text);
      if (!match) return;
      const module = /^(translation|翻译)$/i.test(match[1]) ? 'translation' : 'writing';
      headings.push({ module, y: Math.min(...words.map((word) => Number(word.y))), questionId: '' });
    });
    return headings;
  }

  function renderModuleEntries(view) {
    const entries = [];
    ['writing', 'translation'].forEach((module) => {
      const matches = questions.filter((question) => question.page === view.page.number && question.type === module);
      const located = matches.filter((question) => question.bbox && question.bbox.y >= 0 && question.bbox.y < view.page.height);
      if (located.length) located.forEach((question) => entries.push({ module, y: question.bbox.y, questionId: question.id }));
      else {
        const headings = view.moduleHeadings.filter((heading) => heading.module === module);
        headings.forEach((heading) => entries.push({ ...heading, questionId: matches.length === 1 && headings.length === 1 ? matches[0].id : '' }));
      }
    });
    view.moduleEntryLayer.replaceChildren(...entries.map((entry) => {
      const label = entry.module === 'writing' ? '进入作文模板' : '翻译方法与笔记';
      // Without a parsed writing question there is no numbered control in
      // the inner rail. Put its real heading shortcut beside the paper edge.
      const headingWriting = entry.module === 'writing' && !entry.questionId;
      const link = makeElement('a', `page-module-link page-module-link--${entry.module}${headingWriting ? ' page-module-link--writing-heading' : ''}`, `${label} →`);
      link.dataset.openPageModule = entry.module;
      link.dataset.sourcePage = String(view.page.number);
      link.dataset.moduleQuestion = entry.questionId;
      link.dataset.moduleY = String(entry.y);
      if (entry.questionId) {
        if (entry.module === 'writing') link.dataset.openWritingTemplate = entry.questionId;
        else link.dataset.openTranslationTemplate = entry.questionId;
      }
      link.href = moduleWorkspaceUrl(entry.module, entry.questionId, view.page.number);
      link.style.top = `${entry.y}px`;
      link.setAttribute('aria-label', `${label}，第 ${view.page.number} 页${entry.questionId ? '，当前题目' : ''}`);
      link.title = label;
      return link;
    }));
    if (appliedScale !== null) sizeModuleEntries(view, appliedScale);
  }

  function sizeModuleEntries(view, scale, railWidth = Math.max(QUESTION_RAIL_WIDTH, 44 / scale + MODULE_ENTRY_OFFSET + 6)) {
    const layer = view.moduleEntryLayer;
    layer.style.setProperty('--module-link-offset', `${MODULE_ENTRY_OFFSET}px`);
    layer.style.setProperty('--module-link-height', `${36 / scale}px`);
    layer.style.setProperty('--module-link-font', `${11 / scale}px`);
    layer.style.setProperty('--module-link-padding', `${3 / scale}px`);
    const linkWidth = Math.max(44, (railWidth - MODULE_ENTRY_OFFSET - 6) * scale);
    layer.style.setProperty('--module-link-width', `${linkWidth / scale}px`);
    $$('[data-open-page-module]', layer).forEach((link) => {
      const writing = link.dataset.openPageModule === 'writing';
      const headingWriting = link.classList.contains('page-module-link--writing-heading');
      const physicalWidth = headingWriting ? Math.min(80, Math.max(44, railWidth * scale - 8)) : linkWidth;
      if (headingWriting) {
        link.style.right = `calc(100% + ${8 / scale}px)`;
        link.style.width = `${physicalWidth / scale}px`;
      }
      link.textContent = physicalWidth >= 125 ? (writing ? '进入作文模板 →' : '翻译方法与笔记 →')
        : physicalWidth >= 52 ? (writing ? '作文模板' : '翻译方法') : (writing ? '作文' : '翻译');
    });
  }

  function updateModuleHeaderLinks() {
    [['writing', writingLibraryLink], ['translation', translationLibraryLink]].forEach(([module, link]) => {
      if (!link) return;
      const active = questions.find((question) => question.id === state.currentQuestionId && question.type === module);
      const question = active || questions.find((item) => item.page === currentPage && item.type === module);
      link.dataset.moduleQuestion = question?.id || '';
      link.href = moduleWorkspaceUrl(module, question?.id || '', question?.page || currentPage);
    });
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
    renderModuleEntries(view);
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
      if (!question.objective && ['writing', 'translation'].includes(question.type)) card.classList.add('is-module-question');
      card.dataset.questionId = question.id;
      card.dataset.questionAnchor = question.id;
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', questionLabel(question));
      setQuestionStateClasses(card, status);
      const desiredTop = bbox ? bbox.y : 18 + index * 30;
      card.style.right = 'calc(100% + 5px)';

      const directTranslation = question.type === 'translation';
      const numberButton = makeElement(directTranslation ? 'a' : 'button', 'page-question-number', question.number);
      numberButton.setAttribute('data-toggle-page-question', question.id);
      if (directTranslation) {
        numberButton.href = moduleWorkspaceUrl('translation', question.id, question.page);
        numberButton.dataset.openTranslationTemplate = question.id;
        numberButton.setAttribute('aria-label', `进入${questionLabel(question)}翻译工作台`);
        numberButton.title = '直接进入翻译工作台，查看原文和自己的学习方法';
      } else {
        numberButton.type = 'button';
        numberButton.disabled = controlsDisabled;
        numberButton.setAttribute('aria-expanded', String(expanded));
        numberButton.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${questionLabel(question)}答案选项`);
        numberButton.title = expanded ? `收起${questionLabel(question)}选项` : `选择${questionLabel(question)}答案`;
      }
      numberButton.dataset.answer = question.objective ? selected : status.answered ? '✓' : '';
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
    return String(template.source || '').replace(/\{\{\s*([^{}\r\n]{1,80}?)\s*\}\}/g, (match, rawName) => {
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

    const libraryControls = makeElement('div', 'writing-template-library-controls');
    const libraryLabel = makeElement('label', '', '使用我的模板库');
    const librarySelect = document.createElement('select');
    librarySelect.dataset.writingLibrarySelect = question.id;
    librarySelect.setAttribute('aria-label', '选择我的作文模板');
    const placeholder = makeElement('option', '', '请选择已保存的模板');
    placeholder.value = '';
    librarySelect.append(placeholder);
    let libraryTemplates = [];
    try { libraryTemplates = typeof WritingTemplates !== 'undefined' ? WritingTemplates.list() : []; }
    catch { /* File import remains available if the library is unavailable. */ }
    libraryTemplates.forEach((entry) => {
      const option = makeElement('option', '', entry.name);
      option.value = entry.id;
      librarySelect.append(option);
    });
    if (template?.libraryId && libraryTemplates.some((entry) => entry.id === template.libraryId)) {
      librarySelect.value = template.libraryId;
    }
    librarySelect.disabled = libraryTemplates.length === 0;
    const useTemplate = makeElement('button', '', '使用此模板');
    useTemplate.type = 'button';
    useTemplate.dataset.useWritingLibraryTemplate = question.id;
    useTemplate.disabled = !librarySelect.value;
    const manageLink = makeElement('a', '', libraryTemplates.length ? '打开作文模板库' : '创建我的作文模板');
    manageLink.href = writingTemplateUrl(question.id);
    manageLink.dataset.openWritingTemplate = question.id;
    libraryLabel.append(librarySelect);
    libraryControls.append(libraryLabel, useTemplate, manageLink);
    builder.append(libraryControls);

    if (!template) {
      builder.append(makeElement('p', 'writing-template-preview', ''));
      return builder;
    }

    const slots = makeElement('div', 'writing-template-slots');
    template.slots.forEach((slot, index) => {
      const field = makeElement('div', 'writing-template-slot');
      const label = makeElement('label', 'writing-template-slot-label', slot.name);
      const input = document.createElement(slot.type === 'sentence' || slot.value.length > 90 || /[\r\n]/.test(slot.value) ? 'textarea' : 'input');
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
    const saveToLibrary = makeElement('button', '', '另存到我的模板库');
    saveToLibrary.type = 'button';
    saveToLibrary.dataset.saveWritingLibraryTemplate = question.id;
    actions.append(saveToLibrary, clear, apply);
    builder.append(actions);
    return builder;
  }

  function useWritingLibraryTemplate(questionId) {
    const select = $('[data-writing-library-select]', questionDetail);
    if (!select?.value || typeof WritingTemplates === 'undefined') return;
    try {
      const template = WritingTemplates.get(select.value);
      if (!template) { showToast('模板已被删除，请重新选择'); renderQuestionDetail(); return; }
      const previous = state.writingTemplates[questionId];
      if (previous && !window.confirm('替换本题的模板和填空内容吗？当前作文不会改变。')) return;
      const parsed = parseWritingTemplate(template.source, template.slots);
      state.writingTemplates[questionId] = {
        version: 1, name: template.name, libraryId: template.id,
        source: parsed.source, slots: parsed.slots, updatedAt: Date.now(), lastAppliedAt: 0,
      };
      if (!save(true)) {
        if (previous) state.writingTemplates[questionId] = previous;
        else delete state.writingTemplates[questionId];
        return;
      }
      renderQuestionDetail();
      showToast('模板已载入本题，填空不会修改模板库；确认成稿后再应用到作文');
    } catch (error) { showToast(error.message || '暂时无法读取模板库'); }
  }

  function saveWritingTemplateToLibrary(questionId) {
    const template = state.writingTemplates[questionId];
    if (!template || typeof WritingTemplates === 'undefined') return;
    try {
      WritingTemplates.save({ name: template.name, source: template.source, slots: template.slots });
      renderQuestionDetail();
      showToast('已另存为新模板，可在其他试卷复用，原模板不会被覆盖');
    } catch (error) { showToast(error.message || '模板保存失败，当前内容仍然保留'); }
  }

  function refreshWritingLibrarySelector() {
    const select = $('[data-writing-library-select]', questionDetail);
    if (!select || typeof WritingTemplates === 'undefined') return;
    const selectedId = select.value;
    const useButton = $('[data-use-writing-library-template]', questionDetail);
    try {
      const templates = WritingTemplates.list();
      const placeholder = makeElement('option', '', '请选择已保存的模板');
      placeholder.value = '';
      select.replaceChildren(placeholder, ...templates.map((template) => {
        const option = makeElement('option', '', template.name);
        option.value = template.id;
        return option;
      }));
      if (templates.some((template) => template.id === selectedId)) select.value = selectedId;
      select.disabled = !templates.length;
      const link = select.closest('.writing-template-library-controls')?.querySelector('a');
      if (link) link.textContent = templates.length ? '打开作文模板库' : '创建我的作文模板';
    } catch {
      select.disabled = true;
    }
    if (useButton) useButton.disabled = select.disabled || !select.value;
  }

  // A second tab or the browser back/forward cache may update the library.
  // Refresh only its selector, leaving the current answer and input focus alone.
  window.addEventListener('storage', (event) => {
    if (event.key === 'cet:writing-template-library:v1') refreshWritingLibrarySelector();
    if (event.key === storageKey) syncWorkspaceAnswers();
  });
  $('#answer-conflict-use-current')?.addEventListener('click', () => {
    if (!confirm('确认用本页尚未保存的答案覆盖这些冲突题目的另一窗口版本？其他题目不会更改。')) return;
    try {
      const latest = window.LearningStore.readExam(paperId);
      answerConflicts.forEach((id) => { if (latest.answers?.[id]) answerBaseline[id] = latest.answers[id]; else delete answerBaseline[id]; });
      answerConflicts.clear(); showAnswerConflict(); save(true);
    } catch (_error) { showToast('本机作答无法读取，未执行覆盖。'); }
  });
  $('#answer-conflict-use-saved')?.addEventListener('click', () => {
    if (!confirm('确认采用已经保存的另一窗口版本？本页这些冲突题目的未保存输入将替换，其他题目保持不变。')) return;
    try {
      const latest = window.LearningStore.readExam(paperId);
      answerConflicts.forEach((id) => { if (latest.answers?.[id]) state.answers[id] = answerBaseline[id] = latest.answers[id]; else { delete state.answers[id]; delete answerBaseline[id]; } });
      answerConflicts.clear(); showAnswerConflict(); renderQuestionInterface(); save(true);
    } catch (_error) { showToast('本机作答无法读取，当前输入未改变。'); }
  });
  window.addEventListener('pageshow', syncWorkspaceAnswers);
  window.addEventListener('pageshow', refreshWritingLibrarySelector);
  window.addEventListener('focus', refreshWritingLibrarySelector);

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
      if (question.type === 'translation') {
        const link = makeElement('a', 'question-method-entry', '翻译方法与对照笔记 →');
        link.dataset.openTranslationTemplate = question.id;
        link.href = moduleWorkspaceUrl('translation', question.id, question.page);
        questionDetail.append(link);
      }
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
    updateModuleHeaderLinks();
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
    if (!$('#annotation-sidebar')) return;
    if (!matchMedia('(max-width: 900px)').matches) {
      state.notesPanel = true;
      updateToolbar();
      (questionWorkspace?.hidden ? $('.tag-records') : questionWorkspace)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      if (state.currentQuestionId !== question.id) return;
      const view = pageViews.get(question.page);
      const anchor = view && $$('[data-question-anchor]', view.questionLayer).find((element) => element.dataset.questionAnchor === question.id);
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        viewport.scrollTo({
          top: viewport.scrollTop + rect.top + rect.height / 2 - viewportRect.top - viewport.clientTop - viewport.clientHeight / 2,
          left: viewport.scrollLeft,
          behavior: smooth ? 'smooth' : 'auto',
        });
      }
      anchor?.querySelector('[data-toggle-page-question]')?.focus({ preventScroll: true });
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
        [...aiQuestionDrafts.keys()].filter((key) => key.startsWith('question:')).forEach((key) => aiQuestionDrafts.delete(key));
        [...aiFailures.keys()].filter((key) => key.startsWith('question:')).forEach((key) => aiFailures.delete(key));
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
      const returnQuestion = requestedQuestionId && validIds.has(requestedQuestionId) ? requestedQuestionId : '';
      if (returnQuestion) state.currentQuestionId = returnQuestion;
      if (!validIds.has(state.currentQuestionId)) state.currentQuestionId = questions[0].id;
      questionWorkspace.hidden = false;
      $('#toggle-question-panel').hidden = false;
      if ($('#toggle-question-panel').firstChild) $('#toggle-question-panel').firstChild.textContent = '答题 ';
      $$('[data-question-only]', questionWorkspace).forEach((element) => { element.hidden = false; });
      renderAllPageQuestions();
      applyScale();
      renderQuestionInterface();
      if (returnQuestion) {
        jumpToQuestion(returnQuestion, false);
        // jumpToQuestion locates the page asynchronously; open the matching
        // answer workspace after that, including its mobile overlay.
        setTimeout(openQuestionPanel, 0);
      }
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

  function aiShowServerBanner() {
    const panel = $('#ai-question-panel');
    if (!panel || $('.ai-server-banner', panel)) return;
    const banner = makeElement('div', 'ai-server-banner');
    banner.append(makeElement('b', '', '本地服务未连接'));
    const p = makeElement('p', '', '请在项目目录运行：');
    const code = document.createElement('code');
    code.textContent = '.venv-main/bin/python -m server';
    p.append(code);
    banner.append(p);
    panel.prepend(banner);
  }

  function refreshAiRuntimeUi() {
    const status = $('#ai-runtime-status');
    if (status) status.textContent = window.AgentChat.runtimeLabel(aiRuntime, aiScope);
  }
  window.AgentChat.runtime().then((runtime) => {
    aiRuntime = runtime;
    refreshAiRuntimeUi();
    if (!runtime) aiShowServerBanner();
  });

  const AI_SOURCE_BADGES = {
    official: { label: '含官方解析', className: 'ai-source-chip--official' },
    ai: { label: 'AI 辅助分析', className: 'ai-source-chip--ai' },
  };

  function extractReplyText(content) {
    if (typeof content !== 'string') return '';
    let text = content.trim();
    for (let depth = 0; depth < 3; depth += 1) {
      const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
      const candidate = (fenced ? fenced[1] : text).trim();
      if (!/^[{\[]/.test(candidate) && !/^```json\b/i.test(text)) return text;
      try {
        const parsed = JSON.parse(candidate);
        if (!parsed || Array.isArray(parsed) || typeof parsed.reply !== 'string') return '';
        text = parsed.reply.trim();
      } catch { return ''; }
    }
    return '';
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
    const learningCitations = (Array.isArray(message?.learningCitations) ? message.learningCitations : []).slice(0, 12);
    if (learningCitations.length) {
      const details = document.createElement('details');
      details.append(makeElement('summary', '', '学习方法依据（非官方资料）'));
      const list = document.createElement('ul');
      learningCitations.forEach((citation) => { if (typeof citation?.title === 'string') list.append(makeElement('li', '', citation.title.slice(0, 160))); });
      details.append(list); container.append(details);
    }
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
    if (agent.execution) {
      if (agent.execution.mode) list.append(makeElement('li', '', `执行方式：${agent.execution.mode === 'dynamic_tools' ? '模型选择只读工具' : '确定性流程'}`));
      if (agent.execution.rounds !== null) list.append(makeElement('li', '', `工具决策轮数：${agent.execution.rounds}`));
      if (agent.execution.toolCalls !== null) list.append(makeElement('li', '', `实际工具调用次数：${agent.execution.toolCalls}`));
      if (agent.execution.stopReason) list.append(makeElement('li', '', `结束原因：${agent.execution.stopReason}`));
    }
    if (agent.memory?.enabled) list.append(makeElement('li', '', `会话记忆：${agent.memory.turns ?? '-'} 轮${agent.memory.summaryPresent ? ' · 含历史摘要' : ''}`));
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

  function aiThreadKey(scope = aiScope, questionId = aiPanelQuestionId || state.currentQuestionId) {
    return scope === 'question' ? `question:${questionId}` : scope;
  }

  function rememberAiDraft() {
    const input = $('#ai-question-input');
    if (input) aiQuestionDrafts.set(aiThreadKey(), input.value.slice(0, 2000));
  }

  function restoreAiDraft() {
    const input = $('#ai-question-input');
    if (input) input.value = aiQuestionDrafts.get(aiThreadKey()) || '';
  }

  function refreshAiRequestUi() {
    const key = aiThreadKey();
    const failure = aiFailures.get(key);
    const retry = $('#ai-retry-last');
    if (retry) {
      retry.hidden = !failure?.retryable;
      retry.disabled = aiChatBusy;
    }
    const status = $('#ai-chat-status');
    if (status) {
      status.hidden = !failure && !aiChatBusy;
      status.classList.toggle('is-error', Boolean(failure) && !aiChatBusy);
      status.textContent = aiChatBusy
        ? (aiActiveRequest?.key === key
          ? aiActiveRequest.progress || '请求已发送，等待服务回复。你可以继续编辑下一条问题。'
          : '其他会话的问题正在回复，完成后可返回对应会话查看。')
        : failure?.notice || '';
    }
    const sendButton = $('#ai-send-button');
    if (sendButton) {
      sendButton.disabled = aiChatBusy || aiResetBusy;
      sendButton.textContent = aiChatBusy ? '正在回复…' : '发送问题';
    }
    const newChat = $('#ai-new-chat');
    if (newChat) newChat.disabled = aiChatBusy || aiResetBusy;
    const stop = $('#ai-stop-reply');
    if (stop) { stop.hidden = !aiChatBusy; stop.disabled = aiActiveRequest?.cancelled === true; }
    refreshAiRuntimeUi();
    aiQuestionPanel?.setAttribute('aria-busy', String(aiChatBusy));
  }

  function renderAiConversation() {
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
        const readableReply = extractReplyText(message.content);
        bodyWrapper.append(renderAssistantMarkdown(readableReply || '这条历史回复的格式异常，请重新提问。'));
        container.append(bodyWrapper);
        appendAssistantMetadata(container, { ...message, role: 'assistant' });
        const copyButton = makeElement('button', 'ai-copy-message-button', '复制');
        copyButton.type = 'button';
        copyButton.setAttribute('aria-label', `复制第 ${index + 1} 条 AI 回复`);
        copyButton.addEventListener('click', async () => {
          const copied = readableReply && await copyTextWithFallback(readableReply);
          showToast(copied ? '已复制该条回复' : '浏览器未授权复制');
        });
        container.append(copyButton);
      } else {
        container.append(makeElement('div', '', message.content));
      }
      aiQuestionMessages.append(container);
    });
    const transient = aiChatBusy && aiActiveRequest?.key === aiThreadKey() ? aiActiveRequest : aiFailures.get(aiThreadKey());
    if (transient?.partial) {
      const partial = makeElement('article', 'ai-question-message ai-stream-partial');
      partial.append(makeElement('small', '', aiChatBusy ? '正在接收回复（尚未完成）' : '未完成的回复，仅临时展示，不计入对话历史'));
      partial.append(makeElement('pre', 'ai-stream-text', /^[\s`]*(?:json\s*)?[{\[]/i.test(transient.partial) ? '正在接收结构化响应，等待完整结果…' : transient.partial));
      aiQuestionMessages.append(partial);
    } else if (aiChatBusy && aiActiveRequest?.key === aiThreadKey()) {
      aiQuestionMessages.append(makeElement('p', 'ai-question-message is-pending', '等待服务返回进度与结果…'));
    }
    refreshAiRequestUi();
    aiQuestionMessages.scrollTop = aiQuestionMessages.scrollHeight;
  }

  function renderAiQuestionMessages(questionId, pending = false) {
    return renderAiConversation(pending);
  }

  let aiSelectionRefreshTimer = 0;
  document.addEventListener('selectionchange', () => {
    if (aiChatBusy) return;
    clearTimeout(aiSelectionRefreshTimer);
    aiSelectionRefreshTimer = setTimeout(() => {
      rememberPdfSelection();
    }, 250);
  });

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
      button.disabled = aiChatBusy;
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
    const range = selection.getRangeAt(0);
    const isPdfText = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const layer = element?.closest?.('.page-text-layer');
      return Boolean(layer && pagesNode?.contains(layer));
    };
    // Both ends must belong to PDF text: selecting a sidebar or crossing from
    // the exam into the chat must never silently replace the quoted passage.
    if (!isPdfText(range.startContainer) || !isPdfText(range.endContainer)) return '';
    const text = selection.toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, SELECTED_TEXT_MAX);
  }

  function rememberPdfSelection() {
    if (aiChatBusy) return;
    const captured = capturePdfSelectionText();
    if (!captured || captured === aiSelectionText) return;
    aiSelectionText = captured;
    refreshAiScopeUi(false);
  }

  function setAiScope(scope, { silent = false, rerender = true } = {}) {
    if (aiChatBusy) {
      if (!silent) showToast('AI 正在回复，请稍候再切换模式');
      return;
    }
    if (!['general', 'question', 'selection'].includes(scope)) return;
    if (scope === 'question' && !questions.length) {
      if (!silent) showToast('当前试卷还没有题目，请先使用自由提问');
      return;
    }
    if (scope === 'selection') {
      if (!aiSelectionText) aiSelectionText = capturePdfSelectionText();
      if (!aiSelectionText) {
        if (!silent) showToast('请先在试卷上选中一段文字，再切换到选中文本模式');
        return;
      }
    }
    if (scope !== aiScope) rememberAiDraft();
    aiScope = scope;
    restoreAiDraft();
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
      button.disabled = aiChatBusy
        || (button.dataset.aiScope === 'selection' && !aiSelectionText)
        || (button.dataset.aiScope === 'question' && !questions.length);
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
    const excerpt = $('#ai-selection-excerpt');
    if (excerpt) {
      excerpt.hidden = !aiSelectionText;
      excerpt.textContent = aiSelectionText.length > 240 ? `${aiSelectionText.slice(0, 240)}…` : aiSelectionText;
      excerpt.setAttribute('aria-label', `已引用的试卷文字，共 ${aiSelectionText.length} 个字符`);
    }
    refreshAiRequestUi();
    renderQuickPrompts();
    if (rerender) renderAiConversation();
  }

  function syncAiQuestionContext(questionId = state.currentQuestionId) {
    const question = questions.find((item) => item.id === questionId) || currentQuestion();
    const previousQuestionId = aiPanelQuestionId;
    if (aiScope === 'question' && previousQuestionId !== question?.id) rememberAiDraft();
    if (!question) {
      aiPanelQuestionId = '';
      if (aiScope === 'question') setAiScope('general', { silent: true, rerender: false });
      refreshAiScopeUi();
      return;
    }
    aiPanelQuestionId = question.id;
    if (aiScope === 'question' && previousQuestionId !== question.id) restoreAiDraft();
    refreshAiScopeUi();
  }

  function openAiQuestionPanel(questionId = state.currentQuestionId) {
    if (!paperConfig.assistantUrl) {
      showToast('当前试卷未启用 AI 助手');
      return;
    }
    if (tagEditor?.classList.contains('is-visible')) closeTagEditor();
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
    rememberAiDraft();
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

  function threadForScope(scope, questionId) {
    if (scope === 'general') return state.aiFreeHistory;
    if (scope === 'selection') return state.aiSelectionHistory;
    if (!Array.isArray(state.aiHistory[questionId])) state.aiHistory[questionId] = [];
    return state.aiHistory[questionId];
  }

  function aiHistoryForRequest(thread) {
    return (thread || activeAiThread()).slice(-HISTORY_SEND_MAX).map(({ role, content }) => ({
      role,
      content: String(content).slice(0, HISTORY_CONTENT_MAX),
    }));
  }

  function encodeAiRequest(body) {
    let encoded = JSON.stringify(body);
    const encoder = new TextEncoder();
    while (encoder.encode(encoded).byteLength > AI_REQUEST_MAX_BYTES && body.history.length) {
      body.history.shift();
      // Drop the orphaned answer along with its question when trimming a turn.
      if (body.history[0]?.role === 'assistant') body.history.shift();
      encoded = JSON.stringify(body);
    }
    if (encoder.encode(encoded).byteLength > AI_REQUEST_MAX_BYTES) {
      throw Object.assign(new Error('当前问题和选文合计过长，请缩短后再发送。'), { httpStatus: 413 });
    }
    return encoded;
  }

  function aiFailureNotice(error) {
    if (error?.cancelled) return '已停止生成。未完成内容仅临时展示，你的问题仍保留。已发出的模型请求可能仍产生费用；停止不会自动重试。';
    const reasons = {
      not_configured: '尚未配置 AI 服务，请完成服务器的 API 配置后重试。',
      invalid_configuration: 'AI 服务配置有误，请检查服务器的模型和连接设置后重试。',
      upstream_auth_error: 'AI 服务认证失败，请检查 API Key 后重试。',
      upstream_insufficient_balance: 'AI 服务账户余额不足，请处理账户状态后重试。',
      upstream_rate_limited: 'AI 服务请求过于频繁，请稍候重试。',
      upstream_timeout: 'AI 回复超时，请稍候重试；你的问题已保留。',
      upstream_server_error: 'AI 服务暂时不可用，请稍候重试。',
      upstream_request_error: 'AI 服务未能接受请求，请检查模型设置或调整问题后重试。',
      upstream_response_truncated: 'AI 回复未能完整生成，请重试或让回答更简短。',
      invalid_response: 'AI 返回的格式异常，请重试；你的问题已保留。',
      agent_transport_error: 'AI 助手连接暂时中断，请稍候重试。',
    };
    if (error?.revisionChanged) return '试卷解析已更新，请重新查看本题后再提问。';
    if (error instanceof TypeError) return '无法连接本地服务，请确认服务器正在运行后重试。';
    if (reasons[error?.fallbackReason]) return reasons[error.fallbackReason];
    const status = error?.httpStatus;
    const prefix = status === 400 ? '请求内容未通过校验'
      : status === 413 ? '发送内容过长，请缩短问题或选文'
      : status === 401 || status === 403 ? 'AI 服务认证失败'
      : status === 429 ? '请求过于频繁，请稍候重试'
      : status === 502 || status === 503 ? 'AI 服务暂时不可用'
      : status === 504 ? 'AI 回复超时'
      : '发送失败，请重试';
    const detail = typeof error?.serverDetail === 'string' ? error.serverDetail.trim() : '';
    // Server HTML/JSON and stack traces are never user-facing error content.
    return detail && !/[{}<>\n]/.test(detail) ? `${prefix}：${detail.slice(0, 120)}` : `${prefix}。你的问题已保留。`;
  }

  function aiSourceBadgeFromResponse(data) {
    const grounding = data?.grounding;
    if (data?.scope && data.scope !== 'question') return null;
    if (grounding?.officialExplanationFound === true) return 'official';
    if (grounding?.disclaimerRequired === true || grounding?.officialExplanationFound === false) return 'ai';
    return null;
  }

  async function sendAiQuestion(message, retryContext = null) {
    const requestScope = retryContext?.scope || aiScope;
    const requestQuestionId = requestScope === 'question' ? (retryContext?.questionId || aiPanelQuestionId) : '';
    const selectedText = requestScope === 'selection' ? (retryContext?.selectedText ?? aiSelectionText).slice(0, SELECTED_TEXT_MAX) : '';
    const question = questions.find((item) => item.id === requestQuestionId);
    const cleanMessage = String(message || '').trim().slice(0, 2000);
    if (!cleanMessage || aiChatBusy || aiResetBusy || !paperConfig.assistantUrl) return;
    if (requestScope === 'question') {
      if (!question || !paperConfig.assistantUrl || assistantPendingQuestions.has(question.id)) return;
    }
    if (requestScope === 'selection' && !selectedText.trim()) {
      showToast('请先在试卷上选中一段文字');
      return;
    }

    const targetThread = threadForScope(requestScope, requestQuestionId);
    const key = aiThreadKey(requestScope, requestQuestionId);
    const requestIdBase = ++assistantRequestId;
    const requestContext = {
      key, scope: requestScope, questionId: requestQuestionId, selectedText, message: cleanMessage, partial: '', progress: '', cancelled: false,
    };
    rememberAiDraft();
    const inputAtSend = aiQuestionDrafts.get(key) || '';
    const history = aiHistoryForRequest(targetThread);
    const userTurn = { role: 'user', content: cleanMessage };
    targetThread.push(userTurn);
    if (targetThread.length > THREAD_STORE_MAX) targetThread.splice(0, targetThread.length - THREAD_STORE_MAX);
    aiFailures.delete(key);
    aiActiveRequest = requestContext;
    aiChatBusy = true;
    if (requestQuestionId) assistantPendingQuestions.add(requestQuestionId);
    refreshAiScopeUi();
    save();

    const controller = new AbortController();
    requestContext.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      let body;
      if (requestScope === 'question') {
        body = { scope: 'question', questionId: question.id, message: cleanMessage, history, requestId: `reader-${requestIdBase}` };
        const requestRevision = questionDataRevision;
        if (Number.isInteger(requestRevision) && requestRevision >= 0) body.reviewRevision = requestRevision;
        const userAnswer = String(state.answers[question.id] || '').trim();
        if (userAnswer) body.userAnswer = userAnswer.slice(0, ['writing', 'translation'].includes(question.type) ? MAX_LONG_ANSWER_CHARS : 100);
      } else if (requestScope === 'selection') {
        body = { scope: 'selection', selectedText, message: cleanMessage, history, requestId: `reader-${requestIdBase}` };
      } else {
        body = { scope: 'general', message: cleanMessage, history, requestId: `reader-${requestIdBase}` };
      }

      body.conversationId = state.aiConversations[key] = window.AgentChat.conversationId(state.aiConversations[key]);
      save();
      const data = await window.AgentChat.request({ url: paperConfig.assistantUrl, body: encodeAiRequest(body), signal: controller.signal,
        onProgress: (event) => { requestContext.progress = window.AgentChat.progressLabel(event); refreshAiRequestUi(); },
        onDelta: (text) => {
          requestContext.partial += text;
          if (aiThreadKey() !== key) return;
          let partial = $('.ai-stream-text', aiQuestionMessages);
          if (!partial) { renderAiConversation(); partial = $('.ai-stream-text', aiQuestionMessages); }
          if (partial) partial.textContent = /^[\s`]*(?:json\s*)?[{\[]/i.test(requestContext.partial) ? '正在接收结构化响应，等待完整结果…' : requestContext.partial;
          aiQuestionMessages.scrollTop = aiQuestionMessages.scrollHeight;
        },
      });
      if ((data?.scope && data.scope !== requestScope)
        || (requestScope === 'question' && data?.questionId && data.questionId !== requestQuestionId)) {
        throw Object.assign(new Error('assistant context mismatch'), { fallbackReason: 'invalid_response' });
      }
      const expectedRevision = Number.isInteger(body.reviewRevision) ? body.reviewRevision : null;
      if (
        requestScope === 'question'
        && expectedRevision !== null
        && Number.isInteger(data?.revision)
        && data.revision !== expectedRevision
      ) {
        throw Object.assign(new Error('assistant revision mismatch'), { revisionChanged: true });
      }
      // A page refreshed under us means the request belongs to an older
      // review snapshot; never mix its answer into the new one.
      if (requestScope === 'question' && expectedRevision !== null && expectedRevision !== questionDataRevision) {
        throw Object.assign(new Error('stale request'), { revisionChanged: true, staleRequest: true });
      }
      const generation = normalizeAiGeneration(data?.generation);
      // Free-form deterministic fallbacks are service notices, not answers to
      // the user's question. Grounded question fallbacks remain useful replies.
      if (requestScope !== 'question' && generation && !generation.used) {
        throw Object.assign(new Error('model unavailable'), { fallbackReason: generation.fallbackReason || 'invalid_response' });
      }
      let reply = extractReplyText(data?.reply);
      if (!reply) throw Object.assign(new Error('invalid assistant reply'), { fallbackReason: 'invalid_response' });
      const disclaimer = String(data?.grounding?.disclaimer || '').trim();
      if (disclaimer && !reply.includes(disclaimer)) reply = `${disclaimer}\n\n${reply}`;
      const assistantMessage = { role: 'assistant', content: reply.slice(0, 8000), requestId: requestIdBase };
      const badge = aiSourceBadgeFromResponse(data);
      if (badge) assistantMessage.sourceBadge = badge;
      const citations = normalizeAiCitations(data?.citations ?? data?.grounding?.citations);
      const agent = normalizeAiAgent(data?.agent);
      if (citations.length) assistantMessage.citations = citations;
      if (agent) assistantMessage.agent = agent;
      if (generation) assistantMessage.generation = generation;
      if (Array.isArray(data.learningCitations)) assistantMessage.learningCitations = data.learningCitations.slice(0, 12);
      targetThread.push(assistantMessage);
      if (targetThread.length > THREAD_STORE_MAX) targetThread.splice(0, targetThread.length - THREAD_STORE_MAX);
      const input = $('#ai-question-input');
      const activeRequestThread = aiThreadKey() === key;
      const currentDraft = activeRequestThread && input ? input.value : aiQuestionDrafts.get(key);
      // Clear only the submitted draft, preserving edits and other questions.
      if (currentDraft === inputAtSend && String(currentDraft || '').trim() === cleanMessage) {
        aiQuestionDrafts.delete(key);
        if (activeRequestThread && input) input.value = '';
      }
      $('.ai-server-banner', aiQuestionPanel)?.remove();
    } catch (error) {
      if (requestContext.cancelled) error.cancelled = true;
      else if (error?.name === 'AbortError') error.fallbackReason = 'upstream_timeout';
      // Roll the unanswered user turn back out of the thread so a retry never
      // duplicates it, and give the input back to the user.
      const turnIndex = targetThread.indexOf(userTurn);
      if (turnIndex >= 0) targetThread.splice(turnIndex, 1);
      if (error?.revisionChanged) {
        const unsentDraft = aiThreadKey() === key ? $('#ai-question-input')?.value || cleanMessage : aiQuestionDrafts.get(key) || cleanMessage;
        await loadQuestionData();
        // Loading a new review snapshot correctly clears stale history, but
        // must not throw away the learner's unanswered prompt or failure.
        aiQuestionDrafts.set(key, unsentDraft);
        if (aiThreadKey() === key) restoreAiDraft();
        showToast('试卷解析已更新，请重新查看本题后再提问');
      } else if (error instanceof TypeError) {
        aiShowServerBanner();
      }
      aiFailures.set(key, { ...requestContext, notice: aiFailureNotice(error), retryable: !error?.revisionChanged });
      console.warn('AI chat request failed:', error);
    } finally {
      clearTimeout(timeout);
      aiChatBusy = false;
      aiActiveRequest = null;
      if (requestQuestionId) assistantPendingQuestions.delete(requestQuestionId);
      refreshAiScopeUi();
      save();
    }
  }

  function pageAnnotations(pageNumber) {
    if (annotationIndexDirty) {
      annotationIndex.clear();
      state.annotations.forEach((annotation) => {
        if (!annotationIndex.has(annotation.page)) annotationIndex.set(annotation.page, new Map());
        annotationIndex.get(annotation.page).set(annotation.id, annotation);
      });
      annotationIndexDirty = false;
    }
    return [...(annotationIndex.get(pageNumber)?.values() || [])];
  }

  function renderPageAnnotations(pageNumber) {
    const view = pageViews.get(pageNumber);
    if (!view) return;
    if (!view.annotationNodes) view.annotationNodes = new Map();
    const annotations = pageAnnotations(pageNumber);
    const present = new Set(annotations.map((item) => item.id));
    view.annotationNodes.forEach((nodes, id) => {
      if (!present.has(id)) {
        nodes.group.remove();
        nodes.badge?.remove();
        view.annotationNodes.delete(id);
      }
    });
    annotations.forEach((annotation) => {
      const previous = view.annotationNodes.get(annotation.id);
      if (previous?.annotation === annotation) return;
      previous?.group.remove();
      previous?.badge?.remove();
      const group = createSvgElement('g', { 'data-annotation-id': annotation.id });
      const nodes = { group, annotation, badge: null };
      view.annotationNodes.set(annotation.id, nodes);
      view.markup.append(group);
      if (annotation.type === 'line') {
        group.append(createSvgElement('line', {
          x1: annotation.x1, y1: annotation.y1, x2: annotation.x2, y2: annotation.y2,
          stroke: annotation.color, 'stroke-width': annotation.width, class: 'mark-line',
        }));
        return;
      }
      annotation.rects.forEach((rect) => {
        group.append(createSvgElement('rect', {
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
        nodes.badge = badge;
        view.badgeLayer.append(badge);
      }
    });
  }

  function renderAllAnnotations() {
    pageViews.forEach((_, pageNumber) => renderPageAnnotations(pageNumber));
    renderAnnotationPanel();
  }

  function renderAnnotationPanel() {
    updateNoteDraftUi();
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
      empty.textContent = '拖选试卷文字，点击“笔记”记录想法。';
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
      if (tag.note) button.append(makeElement('p', 'tag-record-note', tag.note));
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
    const removed = pageAnnotations(view.page.number).filter((annotation) => annotationHit(annotation, point));
    if (removed.length) {
      const ids = new Set(removed.map((item) => item.id));
      state.annotations = state.annotations.filter((annotation) => !ids.has(annotation.id));
      erasedDuringGesture.push(...removed.map(cloneAnnotation));
      removed.forEach((annotation) => {
        annotationIndex.get(view.page.number)?.delete(annotation.id);
        const nodes = view.annotationNodes?.get(annotation.id);
        nodes?.group.remove();
        nodes?.badge?.remove();
        view.annotationNodes?.delete(annotation.id);
      });
    }
  }

  function finishMarkupGesture(event, view) {
    if (!activePointer || event.pointerId !== activePointer.pointerId) return;
    cancelAnimationFrame(activePointer.previewFrame);
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
    $('[data-preview]', view.markup)?.remove();
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
      activePointer = { pointerId: event.pointerId, tool: state.tool, start, view, previewFrame: 0 };
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
        activePointer.end = pointOnPage(event, view);
        if (!activePointer.previewFrame) activePointer.previewFrame = requestAnimationFrame(() => {
          if (!activePointer || activePointer.view !== view) return;
          const preview = $('[data-preview]', view.markup);
          preview?.setAttribute('x2', String(activePointer.end.x));
          preview?.setAttribute('y2', String(activePointer.end.y));
          activePointer.previewFrame = 0;
        });
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
    const source = pendingCopy;
    if (!source?.text) return;
    const copied = await copyTextWithFallback(source.text);
    if (pendingCopy !== source) return;
    if (copied) {
      const length = source.text.length;
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

  function hideSelectionToolbar({ clearSelection = false } = {}) {
    selectionToolbar?.classList.remove('is-visible');
    selectionToolbar?.setAttribute('aria-hidden', 'true');
    selectionContext = null;
    selectionRange = null;
    if (clearSelection) window.getSelection()?.removeAllRanges();
  }

  function positionSelectionToolbar() {
    if (!selectionContext || !selectionToolbar?.classList.contains('is-visible')) return;
    const box = selectionRange?.getBoundingClientRect() || tagRectInViewport(selectionContext);
    if (!box) return;
    const width = selectionToolbar.offsetWidth;
    const height = selectionToolbar.offsetHeight;
    const left = clamp(box.left + box.width / 2 - width / 2, 8, Math.max(8, innerWidth - width - 8));
    const top = box.top > height + 12 ? box.top - height - 8 : box.bottom + 8;
    Object.assign(selectionToolbar.style, {
      left: `${left}px`, top: `${clamp(top, 8, Math.max(8, innerHeight - height - 8))}px`,
    });
  }

  function showSelectionToolbar(source, range = null) {
    clearTimeout(selectionChangeTimer);
    selectionContext = source;
    selectionRange = range?.cloneRange() || null;
    if (!selectionToolbar) return;
    selectionToolbar.classList.add('is-visible');
    selectionToolbar.setAttribute('aria-hidden', 'false');
    const color = $('#selection-highlight-color');
    if (color) color.value = source.color || state.highlightColor;
    const lookup = $('[data-selection-action="lookup"]', selectionToolbar);
    if (lookup) lookup.hidden = !source.lookupTarget;
    positionSelectionToolbar();
  }

  function highlightSelection(source) {
    if (!source) return;
    const previous = source.highlightId && state.annotations.find((item) => item.id === source.highlightId);
    const highlight = {
      id: previous?.id || `highlight-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'highlight', page: source.page, rects: source.rects.map((rect) => ({ ...rect })),
      quote: source.quote, wordIds: [...source.wordIds], color: state.highlightColor,
      createdAt: previous?.createdAt || Date.now(),
    };
    if (previous) {
      state.annotations = state.annotations.map((item) => item.id === previous.id ? highlight : item);
      pushHistory({ kind: 'replace', before: cloneAnnotation(previous), after: cloneAnnotation(highlight), label: '修改荧光颜色' });
    } else {
      state.annotations.push(highlight);
      pushHistory({ kind: 'add', items: [cloneAnnotation(highlight)], label: '荧光标记' });
    }
    hideSelectionToolbar({ clearSelection: true });
    renderPageAnnotations(highlight.page);
    renderAnnotationPanel();
    save();
  }

  async function handleSelectionAction(action) {
    const source = selectionContext;
    if (!source) return;
    if (action === 'dismiss') { hideSelectionToolbar({ clearSelection: true }); return; }
    if (action === 'copy') {
      const range = selectionRange?.cloneRange();
      const copied = await copyTextWithFallback(source.text || source.quote);
      if (selectionContext !== source) return;
      if (copied) {
        if (range && selectionContext === source) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        showToast('已复制所选文字');
      } else {
        hideSelectionToolbar();
        openSelectionCopyPanel(source.text || source.quote, source.page);
      }
      return;
    }
    if (action === 'lookup' && source.lookupTarget) {
      hideSelectionToolbar({ clearSelection: true });
      openWordPopover(source.lookupTarget, cleanLookupWord(source.lookupTarget.dataset.word || source.lookupTarget.textContent));
      return;
    }
    if (action === 'highlight') {
      const color = $('#selection-highlight-color')?.value;
      if (/^#[0-9a-f]{6}$/i.test(color || '')) state.highlightColor = color;
      highlightSelection(source);
      updateToolbar();
      return;
    }
    if (action === 'note') {
      closeTagEditor();
      pendingSelection = source;
      activeTag = null;
      hideSelectionToolbar({ clearSelection: true });
      openTagEditor();
      return;
    }
    if (action === 'expression') {
      const text = source.text || source.quote;
      if (text.length > 2000) { showToast('单条表达最多 2,000 字符，请缩小选区。'); return; }
      hideSelectionToolbar({ clearSelection: true });
      window.LearningStore.showExpressionCapture({ text, context: { paper: paperId, question: '', page: source.page, module: 'reader' } });
      return;
    }
    if (action === 'ai') {
      if (aiChatBusy) { showToast('AI 正在回复，请稍候再提问'); return; }
      aiSelectionText = (source.text || source.quote).slice(0, SELECTED_TEXT_MAX);
      hideSelectionToolbar({ clearSelection: true });
      openAiQuestionPanel();
      setAiScope('selection');
      $('#ai-question-input')?.focus({ preventScroll: true });
    }
  }

  function captureTextSelection() {
    // Annotation/copy actions below clear the browser Range. Retain the AI
    // passage first, including fast drags that beat selectionchange debounce.
    rememberPdfSelection();
    if (!['select', 'copy', 'highlight'].includes(state.tool) || tagEditor?.contains(document.activeElement) || $('#selection-copy-panel')?.contains(document.activeElement) || selectionToolbar?.contains(document.activeElement)) return;
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
    const text = selection.toString().replace(/\u00a0/g, ' ').trim().slice(0, 20000) || quote;
    const source = { page, rects, quote, text, wordIds };
    if (state.tool === 'highlight') {
      highlightSelection(source);
      return;
    }
    showSelectionToolbar(source, range);
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

  function draftKeyForSource(source = activeTag || pendingSelection) {
    if (!source) return '';
    if (activeTag) return `tag:${source.id}`;
    if (source.key?.startsWith('selection:')) return source.key;
    const anchor = source.wordIds?.length ? source.wordIds.join(',') : JSON.stringify(source.rects);
    return `selection:${source.page}:${anchor}`;
  }

  function updateNoteDraftUi(message = '') {
    const resume = $('#resume-note-draft');
    if (resume) {
      resume.hidden = noteDrafts.length === 0;
      resume.textContent = `继续未保存的笔记${noteDrafts.length > 1 ? `（${noteDrafts.length}）` : ''}`;
    }
    const source = activeTag || pendingSelection;
    const draft = source && noteDrafts.find((item) => item.key === draftKeyForSource(source));
    const status = $('#note-draft-status');
    if (status) status.textContent = message || (draft ? '草稿已保存在本机 · Ctrl / ⌘ + Enter 保存笔记' : 'Ctrl / ⌘ + Enter 保存笔记；收起后保留草稿');
    const discard = $('#discard-note-draft');
    if (discard) discard.hidden = !draft;
    const panelToggle = $('#toggle-question-panel');
    if (panelToggle && !questions.length && questionWorkspace?.hidden) {
      panelToggle.hidden = false;
      if (panelToggle.firstChild) panelToggle.firstChild.textContent = '笔记 ';
      const count = $('#toolbar-answer-count');
      if (count) count.textContent = String(state.annotations.filter((item) => item.type === 'tag').length);
    }
  }

  function persistNoteDrafts() {
    clearTimeout(noteDraftTimer);
    try {
      if (noteDrafts.length) localStorage.setItem(noteDraftKey, JSON.stringify(noteDrafts));
      else localStorage.removeItem(noteDraftKey);
      updateNoteDraftUi();
      return true;
    } catch {
      updateNoteDraftUi('草稿保存失败，请复制正文或释放本地存储空间');
      return false;
    }
  }

  function rememberNoteDraft() {
    const source = activeTag || pendingSelection;
    if (!source || !tagEditor?.classList.contains('is-visible')) return;
    const key = draftKeyForSource(source);
    const label = tagLabelInput.value.slice(0, 16);
    const note = tagNoteInput.value.slice(0, MAX_NOTE_CHARS);
    const changed = label !== (activeTag?.label || '重点') || note !== (activeTag?.note || '')
      || activeTagTone !== (activeTag?.tone || 'amber');
    const index = noteDrafts.findIndex((item) => item.key === key);
    if (!changed) {
      if (index >= 0) noteDrafts.splice(index, 1);
    } else {
      const draft = { key, tagId: activeTag?.id || '', page: source.page,
        rects: source.rects.map((rect) => ({ ...rect })), wordIds: [...(source.wordIds || [])],
        quote: source.quote, label, note, tone: activeTagTone, updatedAt: Date.now() };
      if (index >= 0) noteDrafts[index] = draft;
      else noteDrafts.push(draft);
    }
    updateNoteDraftUi('草稿保存中…');
    clearTimeout(noteDraftTimer);
    noteDraftTimer = setTimeout(persistNoteDrafts, 180);
  }

  function removeCurrentNoteDraft() {
    const key = draftKeyForSource();
    const index = noteDrafts.findIndex((item) => item.key === key);
    if (index >= 0) noteDrafts.splice(index, 1);
    persistNoteDrafts();
  }

  function resumeNoteDraft() {
    closeTagEditor();
    const draft = [...noteDrafts].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!draft || !pageViews.has(draft.page)) return;
    activeTag = draft.tagId ? state.annotations.find((item) => item.id === draft.tagId && item.type === 'tag') || null : null;
    // If the saved annotation was removed, retain its draft as a new note.
    if (!activeTag && draft.tagId) {
      draft.tagId = '';
      draft.key = `selection:${draft.page}:${draft.wordIds.length ? draft.wordIds.join(',') : JSON.stringify(draft.rects)}`;
      persistNoteDrafts();
    }
    pendingSelection = activeTag ? null : draft;
    hideSelectionToolbar({ clearSelection: true });
    state.tool = 'select';
    updateToolbar();
    jumpToPage(draft.page, true);
    openTagEditor();
  }

  function openTagEditor() {
    const source = activeTag || pendingSelection;
    if (!source || !tagEditor) return;
    closeWordPopover();
    if (aiQuestionPanel?.classList.contains('is-visible')) closeAiQuestionPanel();
    const draft = noteDrafts.find((item) => item.key === draftKeyForSource(source));
    $('#selected-quote').textContent = `“${source.quote || '已选文字'}”`;
    setTagPreset(draft?.label ?? activeTag?.label ?? '重点', draft?.tone || activeTag?.tone || 'amber');
    tagNoteInput.value = draft?.note ?? activeTag?.note ?? '';
    tagDeleteButton.hidden = !activeTag;
    tagEditor.classList.add('is-visible');
    tagEditor.setAttribute('aria-hidden', 'false');
    viewer.classList.add('is-note-editing');
    applyScale();
    updateNoteDraftUi();
    requestAnimationFrame(() => {
      if (!tagEditor.classList.contains('is-visible')) return;
      tagNoteInput.focus({ preventScroll: true });
      tagNoteInput.setSelectionRange(tagNoteInput.value.length, tagNoteInput.value.length);
    });
  }

  function closeTagEditor({ retainDraft = true } = {}) {
    if (retainDraft) {
      rememberNoteDraft();
      persistNoteDrafts();
    }
    tagEditor?.classList.remove('is-visible');
    tagEditor?.setAttribute('aria-hidden', 'true');
    const wasEditing = viewer.classList.contains('is-note-editing');
    viewer.classList.remove('is-note-editing');
    if (wasEditing) applyScale();
    activeTag = null;
    pendingSelection = null;
    updateNoteDraftUi();
  }

  function saveTag() {
    const source = activeTag || pendingSelection;
    const label = tagLabelInput.value.trim() || '重点';
    if (!source) return;
    const next = {
      id: activeTag?.id || `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'tag', page: source.page,
      rects: source.rects.map((rect) => ({ ...rect })),
      quote: source.quote, wordIds: [...(source.wordIds || [])],
      label: label.slice(0, 16), note: tagNoteInput.value.trim().slice(0, MAX_NOTE_CHARS), tone: activeTagTone,
      createdAt: activeTag?.createdAt || Date.now(),
    };
    rememberNoteDraft();
    persistNoteDrafts();
    const previousAnnotations = state.annotations;
    const action = activeTag
      ? { kind: 'replace', before: cloneAnnotation(activeTag), after: cloneAnnotation(next), label: '修改笔记' }
      : { kind: 'add', items: [cloneAnnotation(next)], label: '添加笔记' };
    state.annotations = activeTag
      ? state.annotations.map((item) => item.id === next.id ? next : item)
      : [...state.annotations, next];
    // Commit the note before clearing its recoverable draft. On quota errors,
    // retain both the editor text and the previous saved annotations.
    if (!save(true)) {
      state.annotations = previousAnnotations;
      return;
    }
    pushHistory(action);
    removeCurrentNoteDraft();
    closeTagEditor({ retainDraft: false });
    renderPageAnnotations(next.page);
    renderAnnotationPanel();
    showToast(`已保存笔记：${next.label}`);
  }

  function deleteTag() {
    if (!activeTag) return;
    const removed = cloneAnnotation(activeTag);
    state.annotations = state.annotations.filter((item) => item.id !== removed.id);
    pushHistory({ kind: 'remove', items: [removed], label: '删除标签' });
    removeCurrentNoteDraft();
    closeTagEditor({ retainDraft: false });
    renderPageAnnotations(removed.page);
    renderAnnotationPanel();
    save();
    showToast('标签已删除');
  }

  function openExistingTag(tag) {
    closeTagEditor();
    hideSelectionToolbar({ clearSelection: true });
    jumpToPage(tag.page, true);
    state.tool = 'select';
    updateToolbar();
    activeTag = tag;
    pendingSelection = null;
    openTagEditor();
  }

  function undo() {
    const action = state.history.pop();
    if (!action) return;
    closeTagEditor();
    state.redoHistory.push(action);
    applyAnnotationHistory(action, true);
    showToast(`已撤回：${action.label}`);
  }

  function redo() {
    const action = state.redoHistory.pop();
    if (!action) return;
    closeTagEditor();
    state.history.push(action);
    applyAnnotationHistory(action, false);
    showToast(`已重做：${action.label}`);
  }

  function applyAnnotationHistory(action, reverse) {
    const affectedPages = new Set();
    const kind = action.kind === 'replace' ? 'replace' : reverse
      ? (action.kind === 'add' ? 'remove' : 'add') : action.kind;
    if (kind === 'remove') {
      const ids = new Set(action.items.map((item) => item.id));
      action.items.forEach((item) => affectedPages.add(item.page));
      state.annotations = state.annotations.filter((item) => !ids.has(item.id));
    } else if (kind === 'add') {
      action.items.forEach((item) => { state.annotations.push(cloneAnnotation(item)); affectedPages.add(item.page); });
    } else if (kind === 'replace') {
      const replacement = reverse ? action.before : action.after;
      state.annotations = state.annotations.map((item) => item.id === replacement.id ? cloneAnnotation(replacement) : item);
      affectedPages.add(replacement.page);
    }
    annotationIndexDirty = true;
    affectedPages.forEach(renderPageAnnotations);
    renderAnnotationPanel();
    updateToolbar();
    save();
  }

  function setCurrentPage(pageNumber) {
    currentPage = clamp(pageNumber, 1, manifest?.pageCount || 1);
    updateModuleHeaderLinks();
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
    pageNavigationTarget = page;
    // A question rail is left of the PDF. scrollIntoView can pan horizontally
    // to expose it, pulling a centered, zoomed original towards the right.
    // Locate pages vertically without changing the user's horizontal position.
    viewport.scrollTo({
      top: viewport.scrollTop + view.shell.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop,
      left: viewport.scrollLeft,
      behavior: smooth ? 'smooth' : 'auto',
    });
    setCurrentPage(page);
  }

  function updateCurrentPageFromScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      // At small zoom several pages can fit onscreen simultaneously. Preserve
      // the user's explicit destination until they manually scroll, instead of
      // letting the viewport-center heuristic select a different visible page.
      if (pageNavigationTarget !== null) {
        if (currentPage !== pageNavigationTarget) setCurrentPage(pageNavigationTarget);
        return;
      }
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
    hideSelectionToolbar({ clearSelection: true });
    updateToolbar();
    renderAllPageQuestions();
    save();
    const hint = {
      select: '单击查词；拖选文字后可复制、高亮、记笔记或问 AI',
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
      if (!response.ok) throw Object.assign(new Error(`manifest request failed: ${response.status}`), { httpStatus: response.status });
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
      document.title = `${manifest.title} · CET 学习平台`;
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
      updateNoteDraftUi();
      setCurrentPage(1);
      updateToolbar();
      $('#viewer-loading').hidden = true;
      configureExamAudio();
      if (requestedPageNumber && pageViews.has(requestedPageNumber)) jumpToPage(requestedPageNumber);
      const requestedTag = requestedNoteId && state.annotations.find((item) => item.type === 'tag' && item.id === requestedNoteId);
      if (requestedTag) { jumpToPage(requestedTag.page); openExistingTag(requestedTag); }
      loadQuestionData();
    } catch (error) {
      const loading = $('#viewer-loading');
      loading.replaceChildren();
      const missing = error.httpStatus === 404 || error.httpStatus === 410;
      loading.append(makeElement('h2', '', missing ? '请先上传自己的试卷' : '试卷暂时无法载入'));
      loading.append(makeElement('p', '', missing
        ? '此试卷不在你的上传资料中。平台提供阅读、笔记与 AI 辅导工具，试卷、答案和听力由你上传。'
        : '请确认本地服务已启动，或返回试卷库重试。已有学习记录仍保留在当前浏览器中。'));
      const uploadLink = makeElement('a', 'primary-button', '上传试卷');
      uploadLink.href = 'upload.html';
      const libraryLink = makeElement('a', 'secondary-button', '我的试卷');
      libraryLink.href = 'index.html#papers';
      loading.append(uploadLink, document.createTextNode(' '), libraryLink);
      if (aiLauncher) aiLauncher.hidden = true;
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
  $('#redo-mark')?.addEventListener('click', redo);
  selectionToolbar?.addEventListener('pointerdown', (event) => {
    // Keep the native selection when using a mouse action. Color inputs and
    // keyboard navigation retain their normal focus behavior.
    if (event.target.closest('button')) event.preventDefault();
  });
  selectionToolbar?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-selection-action]');
    if (button) handleSelectionAction(button.dataset.selectionAction);
  });
  $('#selection-highlight-color')?.addEventListener('input', (event) => {
    state.highlightColor = event.currentTarget.value;
    updateToolbar();
    save();
  });
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
  document.addEventListener('pointerdown', (event) => {
    rememberPdfSelection();
    selectionPointerActive = true;
    aiPointerDownInsidePanel = Boolean(event.target?.closest?.('#ai-question-panel'));
    if (selectionContext && !event.target?.closest?.('#selection-toolbar, .page-text-layer')) hideSelectionToolbar();
  }, { passive: true, capture: true });
  document.addEventListener('pointerup', (event) => {
    selectionPointerActive = false;
    if (aiPointerDownInsidePanel || event.target?.closest?.('#selection-toolbar, #tag-editor, #selection-copy-panel')) return;
    rememberPdfSelection();
    setTimeout(captureTextSelection, 0);
  });
  document.addEventListener('pointercancel', () => { selectionPointerActive = false; });
  document.addEventListener('selectionchange', () => {
    if (!['copy', 'select'].includes(state.tool)) return;
    clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => {
      if (!selectionPointerActive && (state.tool === 'select' || !matchMedia('(pointer: coarse)').matches)) {
        if (selectionRange && window.getSelection()?.isCollapsed && !selectionToolbar?.contains(document.activeElement)) hideSelectionToolbar();
        else captureTextSelection();
      }
    }, 180);
  });
  pagesNode?.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-writing-template], [data-open-translation-template], [data-open-page-module]')) return;
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
      const highlight = pageAnnotations(Number(word.dataset.page)).slice().reverse().find((item) =>
        item.type === 'highlight' && item.wordIds.includes(Number(word.dataset.wordId)));
      if (highlight) {
        closeWordPopover();
        showSelectionToolbar({ ...highlight, highlightId: highlight.id, text: highlight.quote, lookupTarget: word });
        return;
      }
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
    const librarySelect = event.target.closest('[data-writing-library-select]');
    if (librarySelect) {
      const button = $('[data-use-writing-library-template]', questionDetail);
      if (button) button.disabled = !librarySelect.value;
      return;
    }
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
    if (event.target.closest('[data-open-writing-template], [data-open-translation-template]')) return;
    const useLibraryTemplate = event.target.closest('[data-use-writing-library-template]');
    if (useLibraryTemplate) { useWritingLibraryTemplate(useLibraryTemplate.dataset.useWritingLibraryTemplate); return; }
    const saveLibraryTemplate = event.target.closest('[data-save-writing-library-template]');
    if (saveLibraryTemplate) { saveWritingTemplateToLibrary(saveLibraryTemplate.dataset.saveWritingLibraryTemplate); return; }
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
    sendAiQuestion(message);
  });
  $('#ai-question-input')?.addEventListener('input', rememberAiDraft);
  $$('.ai-scope-switcher [data-ai-scope]').forEach((button) => {
    button.addEventListener('click', () => setAiScope(button.dataset.aiScope));
  });
  $('#ai-new-chat')?.addEventListener('click', async () => {
    if (aiChatBusy || aiResetBusy) return;
    const key = aiThreadKey(); const scope = aiScope; const questionId = aiPanelQuestionId || state.currentQuestionId;
    const thread = activeAiThread(); const id = state.aiConversations[key];
    aiResetBusy = true; refreshAiRequestUi();
    try {
      if (id) await window.AgentChat.clearConversation({ url: paperConfig.assistantUrl, conversationId: id, scope, questionId });
      thread.splice(0); aiFailures.delete(key); aiQuestionDrafts.delete(key);
      state.aiConversations[key] = window.AgentChat.conversationId();
      if (aiThreadKey() === key) restoreAiDraft();
      save();
      showToast('已开始新的对话；支持记忆的当前题目已先清除服务端记忆，其他会话不受影响');
    } catch (_error) { showToast('服务端会话记忆未能清除，已保留当前对话，请稍后重试。'); }
    finally { aiResetBusy = false; renderAiConversation(); }
  });
  $('#ai-stop-reply')?.addEventListener('click', () => {
    if (!aiChatBusy || !aiActiveRequest) return;
    aiActiveRequest.cancelled = true; aiActiveRequest.controller?.abort(); refreshAiRequestUi();
  });
  $('#ai-copy-last')?.addEventListener('click', async () => {
    const thread = activeAiThread();
    for (let index = thread.length - 1; index >= 0; index -= 1) {
      if (thread[index].role === 'assistant') {
        const reply = extractReplyText(thread[index].content);
        const copied = reply && await copyTextWithFallback(reply);
        showToast(copied ? '已复制最近一条 AI 回复' : '浏览器未授权复制');
        return;
      }
    }
    showToast('当前对话还没有 AI 回复');
  });
  $('#ai-retry-last')?.addEventListener('click', () => {
    const failure = aiFailures.get(aiThreadKey());
    if (!failure?.retryable || aiChatBusy) return;
    if (failure.scope === 'selection') aiSelectionText = failure.selectedText;
    refreshAiScopeUi(false);
    sendAiQuestion(failure.message, failure);
  });
  $('#tag-record-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-record-tag-id]');
    const tag = button && state.annotations.find((item) => item.id === button.dataset.recordTagId && item.type === 'tag');
    if (tag) openExistingTag(tag);
  });
  $$('[data-tag-label]').forEach((button) => button.addEventListener('click', () => {
    setTagPreset(button.dataset.tagLabel, button.dataset.tagTone);
    rememberNoteDraft();
  }));
  tagLabelInput?.addEventListener('input', () => {
    $$('[data-tag-label]').forEach((button) => button.setAttribute('aria-checked', 'false'));
    rememberNoteDraft();
  });
  tagNoteInput?.addEventListener('input', rememberNoteDraft);
  $('#resume-note-draft')?.addEventListener('click', resumeNoteDraft);
  $('#discard-note-draft')?.addEventListener('click', () => {
    removeCurrentNoteDraft();
    closeTagEditor({ retainDraft: false });
    showToast('已丢弃当前草稿');
  });
  $('#save-tag')?.addEventListener('click', saveTag);
  $('#cancel-tag')?.addEventListener('click', closeTagEditor);
  tagDeleteButton?.addEventListener('click', deleteTag);
  $('#copy-selection-text')?.addEventListener('click', copyPendingSelection);
  $('#close-selection-copy')?.addEventListener('click', closeSelectionCopyPanel);
  $('[data-close-selection-copy]')?.addEventListener('click', closeSelectionCopyPanel);
  viewport?.addEventListener('scroll', () => {
    updateCurrentPageFromScroll();
    positionSelectionToolbar();
  }, { passive: true });
  addEventListener('resize', () => {
    applyScale();
    positionSelectionToolbar();
  });
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input, textarea, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && tagEditor?.contains(event.target)
      && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); saveTag(); return;
    }
    if ((event.ctrlKey || event.metaKey) && !typing) {
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault(); if (event.shiftKey) redo(); else undo(); return;
      }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    }
    if (event.key === 'Escape') {
      hideSelectionToolbar({ clearSelection: true });
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
  const releasePageNavigation = () => { pageNavigationTarget = null; };
  viewport?.addEventListener('wheel', releasePageNavigation, { passive: true });
  viewport?.addEventListener('touchstart', releasePageNavigation, { passive: true });
  viewport?.addEventListener('pointerdown', releasePageNavigation, { passive: true });
  viewport?.addEventListener('keydown', (event) => {
    if (!event.target.closest('input, textarea, select, [contenteditable="true"]')
      && ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) releasePageNavigation();
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-open-writing-template], [data-open-translation-template], [data-open-page-module], #open-writing-library, #open-translation-library');
    if (!link || link.getAttribute('aria-disabled') === 'true') return;
    const targetId = link.dataset.openWritingTemplate || link.dataset.openTranslationTemplate || link.dataset.moduleQuestion
      || (link.id === 'open-writing-library' ? state.currentQuestionId : '');
    const question = questions.find((item) => item.id === targetId);
    const previousQuestion = state.currentQuestionId;
    if (question) state.currentQuestionId = question.id;
    rememberNoteDraft();
    const draftSaved = (!noteDrafts.length && !tagEditor?.classList.contains('is-visible')) || persistNoteDrafts();
    // Flush answers before following the normal anchor navigation. A failed
    // write must not silently leave this page with the only copy of an essay.
    if (!draftSaved || !save(true)) {
      state.currentQuestionId = previousQuestion;
      event.preventDefault();
      showToast('作答或笔记尚未保存，已暂停跳转；请保留当前内容后重试');
    }
  });

  initialize();
})();
