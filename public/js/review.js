(() => {
  'use strict';

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const SAFE_EXAM_ID = /^exam-[0-9]{8}-[0-9a-f]{12}$/;
  const SAFE_QUESTION_ID = /^(?:q([1-9][0-9]{0,2})|(writing|translation)-([1-9][0-9]{0,2}))$/;
  const QUESTION_TYPES = new Set(['single_choice', 'matching', 'writing', 'translation', 'unknown']);
  const LONG_TYPES = new Set(['writing', 'translation']);
  const OPTION_LABELS = 'ABCDEFGHIJKLMNO';
  const GENERIC_REASONS = new Set(['修改', '调整', '复核', '确认', '修正', 'update', 'edit', 'review']);

  const workspace = $('#review-workspace');
  const fatalState = $('#fatal-state');
  const fatalMessage = $('#fatal-message');
  const queueList = $('#queue-list');
  const queueEmpty = $('#queue-empty');
  const form = $('#review-form');
  const editorEmpty = $('#editor-empty');
  const editorTitle = $('#editor-title');
  const issueSummary = $('#issue-summary');
  const optionEditor = $('#option-editor');
  const pageCanvas = $('#page-canvas');
  const pageImage = $('#page-image');
  const pagePlaceholder = $('#page-placeholder');
  const bboxOverlay = $('#bbox-overlay');
  const pageSelect = $('#preview-page');
  const conflictBanner = $('#conflict-banner');
  const saveButton = $('#save-review');
  const dirtyIndicator = $('#dirty-indicator');
  const formError = $('#form-error');
  const questionType = $('#question-type');
  const removeAnswerWithSave = $('#remove-answer-with-save');
  const answerRemovalControl = $('#answer-removal-control');

  const params = new URLSearchParams(location.search);
  const requestedExamId = String(params.get('exam') || '').trim();
  const state = {
    examId: SAFE_EXAM_ID.test(requestedExamId) ? requestedExamId : '',
    reviewUrl: '',
    revision: 0,
    etag: '',
    review: null,
    manifest: null,
    questions: [],
    answers: [],
    issues: [],
    items: [],
    activeKey: '',
    activeIsNew: false,
    filter: 'pending',
    search: '',
    dirty: false,
    populating: false,
    busy: false,
    conflicted: false,
    previewPage: 1,
    loadGeneration: 0,
    toastTimer: 0,
    activeItem: null,
    questionFormBaseline: '',
    answerFormBaseline: '',
    busyAction: '',
  };
  state.reviewUrl = state.examId ? `/api/exams/${state.examId}/review` : '';

  function text(value, maximum = 12000) {
    return String(value ?? '').trim().slice(0, maximum);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function makeElement(tag, className = '', content = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== '') element.textContent = String(content);
    return element;
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    clearTimeout(state.toastTimer);
    toast.textContent = text(message, 300);
    toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function showFatal(message) {
    if (workspace) workspace.hidden = true;
    if (fatalMessage) fatalMessage.textContent = text(message, 1000) || '请确认试卷已解析完成并重新打开。';
    if (fatalState) {
      fatalState.hidden = false;
      fatalState.focus();
    }
  }

  function clearFatal() {
    if (fatalState) fatalState.hidden = true;
    if (workspace) workspace.hidden = false;
  }

  function setFormError(message) {
    if (!formError) return;
    formError.textContent = text(message, 1000);
    formError.hidden = !message;
    if (message) formError.focus();
  }

  function setDirty(value) {
    state.dirty = Boolean(value);
    if (dirtyIndicator) dirtyIndicator.hidden = !state.dirty;
  }

  function setBusy(value, action = 'save') {
    state.busy = Boolean(value);
    state.busyAction = state.busy ? action : '';
    if (workspace) workspace.setAttribute('aria-busy', String(state.busy));
    if (saveButton) {
      saveButton.disabled = state.busy || state.conflicted;
      saveButton.textContent = state.busy ? (action === 'load' ? '正在读取…' : '正在保存…') : '保存复核';
    }
    const interactionLocked = state.busy || state.conflicted;
    const lockedRegions = [$('.review-queue'), $('.page-preview'), $('.review-editor')].filter(Boolean);
    lockedRegions.forEach((region) => region.toggleAttribute('inert', interactionLocked));
    const reload = $('#reload-review');
    const reset = $('#reset-form');
    const retry = $('#retry-load');
    const removeQuestion = $('#remove-question');
    const removeAnswer = $('#remove-answer');
    if (reload) reload.disabled = state.busy;
    if (reset) reset.disabled = state.busy;
    if (retry) retry.disabled = state.busy;
    if (removeQuestion) removeQuestion.disabled = state.busy || state.conflicted || !state.activeItem?.question || state.activeIsNew;
    if (removeAnswer) removeAnswer.disabled = state.busy || state.conflicted || !state.activeItem?.answer || state.activeIsNew;
  }

  function confirmDiscard() {
    return !state.dirty || window.confirm('当前表单有尚未保存的修改，确定放弃吗？');
  }

  function listFrom(value, key) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
    return [];
  }

  function normalizeOptions(value) {
    const source = Array.isArray(value) ? value : [];
    const labels = new Set();
    return source.slice(0, 15).map((option, index) => {
      const label = text(option?.label ?? option?.key ?? OPTION_LABELS[index], 1).toUpperCase();
      return { label, text: text(option?.text ?? option?.content ?? '', 4000) };
    }).filter((option) => {
      if (!OPTION_LABELS.includes(option.label) || labels.has(option.label)) return false;
      labels.add(option.label);
      return true;
    });
  }

  function normalizeQuestion(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const questionId = text(raw.questionId ?? raw.id, 32);
    if (!SAFE_QUESTION_ID.test(questionId)) return null;
    const type = QUESTION_TYPES.has(String(raw.type)) ? String(raw.type) : 'unknown';
    const bbox = raw.bbox && typeof raw.bbox === 'object' ? raw.bbox : {};
    const confidenceValue = Number(raw.confidence);
    return {
      questionId,
      number: raw.number ?? questionId.replace(/^q/, ''),
      type,
      page: Math.max(1, Math.floor(number(raw.page, 1))),
      bbox: {
        x: Math.max(0, number(bbox.x)),
        y: Math.max(0, number(bbox.y)),
        width: Math.max(0, number(bbox.width)),
        height: Math.max(0, number(bbox.height)),
      },
      stem: text(raw.stem ?? raw.text ?? raw.prompt, 12000),
      options: normalizeOptions(raw.options),
      confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue > 1 ? confidenceValue / 100 : confidenceValue)) : null,
      reviewRequired: raw.reviewRequired === true,
      reviewStatus: text(raw.reviewStatus, 40),
      source: text(raw.source, 40),
    };
  }

  function normalizeAnswer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const questionId = text(raw.questionId ?? raw.id, 32);
    if (!SAFE_QUESTION_ID.test(questionId)) return null;
    const confidenceValue = Number(raw.confidence);
    return {
      questionId,
      answer: text(raw.answer, 1).toUpperCase(),
      explanation: text(raw.explanation, 12000),
      confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue > 1 ? confidenceValue / 100 : confidenceValue)) : null,
      reviewRequired: raw.reviewRequired === true,
      reviewStatus: text(raw.reviewStatus, 40),
    };
  }

  function normalizeIssue(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const targetId = text(raw.targetId ?? raw.questionId, 32);
    if (!SAFE_QUESTION_ID.test(targetId)) return null;
    const kind = text(raw.kind ?? raw.type ?? 'review', 60).toLowerCase();
    return {
      issueId: text(raw.issueId ?? `${kind}:${targetId}:${index}`, 160),
      targetId,
      kind,
      message: text(raw.message ?? raw.reason ?? '该项目需要人工确认。', 500),
      page: Math.max(0, Math.floor(number(raw.page))),
      severity: text(raw.severity ?? raw.reviewStatus, 40),
    };
  }

  function pageDimensions(pageNumber) {
    const page = listFrom(state.manifest, 'pages').find((item) => Number(item?.number) === Number(pageNumber));
    if (!page) return null;
    const width = number(page.width);
    const height = number(page.height);
    return width > 0 && height > 0 ? { width, height, page } : null;
  }

  function itemCategories(item) {
    const kinds = item.issues.map((issue) => issue.kind);
    const missing = !item.question || kinds.includes('missing_question') || kinds.some((kind) => /missing|unresolved/.test(kind));
    const conflict = kinds.some((kind) => /conflict/.test(kind));
    const confidence = item.question?.confidence;
    const low = Boolean(
      item.question?.reviewRequired
      || item.answer?.reviewRequired
      || (Number.isFinite(confidence) && confidence < .95)
      || kinds.some((kind) => /question_review|answer_review|confidence/.test(kind))
    );
    return { missing, conflict, low, pending: missing || conflict || low || item.issues.length > 0 };
  }

  function buildItems() {
    const questionMap = new Map(state.questions.map((question) => [question.questionId, question]));
    const answerMap = new Map(state.answers.map((answer) => [answer.questionId, answer]));
    const ids = new Set([...questionMap.keys(), ...answerMap.keys(), ...state.issues.map((issue) => issue.targetId)]);
    const sortKey = (questionId) => {
      const match = /^q(\d+)$/.exec(questionId);
      return match ? [0, Number(match[1]), ''] : [1, 0, questionId];
    };
    state.items = [...ids].map((questionId) => {
      const item = {
        key: questionId,
        questionId,
        question: questionMap.get(questionId) || null,
        answer: answerMap.get(questionId) || null,
        issues: state.issues.filter((issue) => issue.targetId === questionId),
      };
      return { ...item, categories: itemCategories(item) };
    }).sort((left, right) => {
      const a = sortKey(left.questionId);
      const b = sortKey(right.questionId);
      return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], 'zh-CN');
    });
  }

  function matchesFilter(item) {
    if (state.filter === 'all') return true;
    return Boolean(item.categories[state.filter]);
  }

  function filteredItems() {
    const query = state.search.toLocaleLowerCase('zh-CN');
    return state.items.filter((item) => {
      if (!matchesFilter(item)) return false;
      if (!query) return true;
      const haystack = [item.questionId, item.question?.number, item.question?.stem, item.answer?.answer, ...item.issues.map((issue) => issue.message)].join(' ').toLocaleLowerCase('zh-CN');
      return haystack.includes(query);
    });
  }

  function addBadge(container, content, modifier = '') {
    const badge = makeElement('span', `queue-badge${modifier ? ` queue-badge--${modifier}` : ''}`, content);
    container.append(badge);
  }

  function renderMetrics() {
    $('#metric-total').textContent = String(state.items.length);
    $('#metric-pending').textContent = String(state.items.filter((item) => item.categories.pending).length);
    $('#metric-missing').textContent = String(state.items.filter((item) => item.categories.missing).length);
    $('#metric-conflict').textContent = String(state.items.filter((item) => item.categories.conflict).length);
  }

  function renderQueue() {
    if (!queueList) return;
    const items = filteredItems();
    const focusedKey = document.activeElement?.dataset?.itemKey || '';
    queueList.replaceChildren();
    const activeIsVisible = items.some((item) => item.key === state.activeKey && !state.activeIsNew);
    items.forEach((item, index) => {
      const button = makeElement('button', 'queue-item');
      button.type = 'button';
      button.dataset.itemKey = item.key;
      const isCurrent = item.key === state.activeKey && !state.activeIsNew;
      if (isCurrent) button.setAttribute('aria-current', 'true');
      button.tabIndex = isCurrent || (!activeIsVisible && index === 0) ? 0 : -1;
      button.classList.toggle('is-missing', item.categories.missing);
      button.classList.toggle('is-conflict', item.categories.conflict);

      const shownNumber = item.question?.number ?? item.questionId.replace(/^q/, '');
      const numberBadge = makeElement('span', 'queue-number', shownNumber);
      const copy = makeElement('span', 'queue-item-copy');
      copy.append(makeElement('strong', '', item.question ? `${item.questionId} · ${typeLabel(item.question.type)}` : `${item.questionId} · 缺失题目`));
      copy.append(makeElement('small', '', item.question?.stem || item.issues[0]?.message || '尚未录入题干'));
      const badges = makeElement('span', 'queue-badges');
      if (item.categories.missing) addBadge(badges, '缺题');
      if (item.categories.conflict) addBadge(badges, '冲突', 'conflict');
      if (item.categories.low) {
        const score = item.question?.confidence;
        addBadge(badges, Number.isFinite(score) ? `${Math.round(score * 100)}%` : '待复核');
      }
      if (!item.categories.pending) addBadge(badges, '已确认', 'ok');
      copy.append(badges);
      button.append(numberBadge, copy);
      queueList.append(button);
    });
    if (queueEmpty) queueEmpty.hidden = items.length > 0;
    if (focusedKey) {
      const replacement = [...queueList.querySelectorAll('[data-item-key]')]
        .find((button) => button.dataset.itemKey === focusedKey);
      replacement?.focus({ preventScroll: true });
    }
  }

  function typeLabel(value) {
    return ({
      single_choice: '单项选择', matching: '段落匹配', writing: '写作', translation: '翻译', unknown: '待确认',
    })[value] || '待确认';
  }

  function renderIssueSummary(item) {
    if (!issueSummary) return;
    issueSummary.replaceChildren();
    if (!item.issues.length && !item.categories.pending) {
      issueSummary.classList.add('is-clear');
      issueSummary.append(makeElement('strong', '', '当前项目没有未解决问题'));
      issueSummary.append(document.createTextNode('仍可对照原卷修正内容；保存后会创建新的人工复核版本。'));
      return;
    }
    issueSummary.classList.remove('is-clear');
    issueSummary.append(makeElement('strong', '', item.categories.missing ? '需要补录题目' : '需要人工确认'));
    const list = document.createElement('ul');
    const messages = item.issues.length ? item.issues.map((issue) => issue.message) : ['解析置信度低于可靠阈值，请对照原卷检查。'];
    messages.slice(0, 8).forEach((message) => list.append(makeElement('li', '', message)));
    issueSummary.append(list);
  }

  function appendOptionRow(option = { label: '', text: '' }) {
    const row = makeElement('div', 'option-row');
    row.dataset.optionRow = '';
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 1;
    label.autocomplete = 'off';
    label.setAttribute('aria-label', '选项字母');
    label.dataset.optionLabel = '';
    label.value = text(option.label, 1).toUpperCase();
    const optionText = document.createElement('input');
    optionText.type = 'text';
    optionText.maxLength = 4000;
    optionText.autocomplete = 'off';
    optionText.setAttribute('aria-label', `${label.value || '新'}选项内容`);
    optionText.dataset.optionText = '';
    optionText.value = text(option.text, 4000);
    const remove = makeElement('button', 'option-remove', '×');
    remove.type = 'button';
    remove.dataset.removeOption = '';
    remove.setAttribute('aria-label', `移除${label.value || '当前'}选项`);
    row.append(label, optionText, remove);
    optionEditor.append(row);
  }

  function renderOptions(options) {
    if (!optionEditor) return;
    optionEditor.replaceChildren();
    options.forEach(appendOptionRow);
    if (!options.length) optionEditor.append(makeElement('p', 'option-empty', '当前题型没有选项。选择客观题型后可添加 A–O。'));
  }

  function defaultQuestion(questionId, issue = null) {
    const numeric = /^q(\d+)$/.exec(questionId);
    const long = /^(writing|translation)-/.exec(questionId);
    return {
      questionId,
      number: numeric ? Number(numeric[1]) : long?.[1] === 'writing' ? '写作' : long ? '翻译' : '',
      type: long?.[1] || 'unknown',
      page: issue?.page || state.previewPage || 1,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      stem: '',
      options: [],
    };
  }

  function populateForm(item, isNew = false) {
    const issue = item.issues?.[0] || null;
    const question = item.question || defaultQuestion(item.questionId, issue);
    const answer = item.answer || { answer: '', explanation: '' };
    state.populating = true;
    state.activeKey = item.key;
    state.activeIsNew = isNew;
    state.activeItem = item;
    setFormError('');
    editorEmpty.hidden = true;
    form.hidden = false;
    editorTitle.textContent = isNew ? '新增题目' : `${item.questionId} · ${typeLabel(question.type)}`;
    $('#question-id').value = question.questionId;
    $('#question-id').readOnly = Boolean(item.question) && !isNew;
    $('#question-number').value = String(question.number ?? '');
    questionType.value = QUESTION_TYPES.has(question.type) ? question.type : 'unknown';
    questionType.dataset.previousValue = questionType.value;
    $('#question-stem').value = question.stem;
    $('#question-page').value = String(question.page || 1);
    $('#bbox-x').value = question.bbox.width > 0 ? String(question.bbox.x) : '';
    $('#bbox-y').value = question.bbox.height > 0 ? String(question.bbox.y) : '';
    $('#bbox-width').value = question.bbox.width > 0 ? String(question.bbox.width) : '';
    $('#bbox-height').value = question.bbox.height > 0 ? String(question.bbox.height) : '';
    $('#answer-value').value = answer.answer;
    $('#answer-explanation').value = answer.explanation;
    removeAnswerWithSave.checked = false;
    removeAnswerWithSave.disabled = !item.answer || isNew;
    answerRemovalControl.hidden = !item.answer || isNew;
    setAnswerRemovalMode(false);
    $('#review-reason').value = '';
    renderOptions(question.options);
    renderIssueSummary({ ...item, categories: item.categories || itemCategories(item) });
    $('#remove-question').disabled = state.conflicted || !item.question || isNew;
    $('#remove-answer').disabled = state.conflicted || !item.answer || isNew;
    state.previewPage = Math.max(1, Number(question.page) || 1);
    pageSelect.value = String(state.previewPage);
    updatePagePreview();
    state.questionFormBaseline = serializeFormSnapshot(questionFormSnapshot());
    state.answerFormBaseline = serializeFormSnapshot(answerFormSnapshot());
    state.populating = false;
    setDirty(false);
    renderQueue();
  }

  function selectItem(key) {
    if (state.conflicted) {
      showToast('服务器版本已变化，请先读取最新版本');
      $('#reload-conflict')?.focus();
      return;
    }
    const item = state.items.find((candidate) => candidate.key === key);
    if (!item || (key === state.activeKey && !state.activeIsNew)) return;
    if (!confirmDiscard()) return;
    populateForm(item);
  }

  function nextFreeQuestionId() {
    const used = new Set(state.questions.map((question) => question.questionId));
    const missing = state.items.find((item) => item.categories.missing && /^q\d+$/.test(item.questionId));
    if (missing) return missing.questionId;
    for (let index = 1; index <= 200; index += 1) {
      if (!used.has(`q${index}`)) return `q${index}`;
    }
    return 'writing-1';
  }

  function beginNewQuestion() {
    if (state.conflicted) {
      showToast('服务器版本已变化，请先读取最新版本');
      $('#reload-conflict')?.focus();
      return;
    }
    if (!confirmDiscard()) return;
    const questionId = nextFreeQuestionId();
    const issue = state.issues.find((candidate) => candidate.targetId === questionId) || null;
    const item = {
      key: `new:${questionId}`,
      questionId,
      question: null,
      answer: null,
      issues: issue ? [issue] : [],
    };
    item.categories = itemCategories(item);
    populateForm(item, true);
    $('#question-id').readOnly = false;
    $('#question-id').focus();
  }

  function pageImageUrl(page) {
    const raw = text(page?.image, 1000);
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      const prefix = `/api/exams/${state.examId}/assets/pages/`;
      return url.origin === location.origin && url.pathname.startsWith(prefix) ? url.href : '';
    } catch {
      return '';
    }
  }

  function renderPageChoices() {
    if (!pageSelect) return;
    pageSelect.replaceChildren();
    listFrom(state.manifest, 'pages').forEach((page) => {
      const pageNumber = Math.floor(number(page?.number));
      if (pageNumber <= 0) return;
      const option = document.createElement('option');
      option.value = String(pageNumber);
      option.textContent = `第 ${pageNumber} 页`;
      pageSelect.append(option);
    });
    if (!pageSelect.options.length) {
      const option = document.createElement('option');
      option.value = '1';
      option.textContent = '无页面';
      pageSelect.append(option);
    }
    state.previewPage = pageDimensions(state.previewPage) ? state.previewPage : Number(pageSelect.options[0].value);
    pageSelect.value = String(state.previewPage);
  }

  function formBBox() {
    const inputNumber = (selector) => {
      const raw = $(selector)?.value;
      if (typeof raw !== 'string' || raw.trim() === '') return NaN;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : NaN;
    };
    return {
      page: Math.floor(inputNumber('#question-page')),
      x: inputNumber('#bbox-x'),
      y: inputNumber('#bbox-y'),
      width: inputNumber('#bbox-width'),
      height: inputNumber('#bbox-height'),
    };
  }

  function updateBBoxOverlay() {
    if (!bboxOverlay) return;
    const box = formBBox();
    const dimensions = pageDimensions(state.previewPage);
    const visible = dimensions
      && box.page === state.previewPage
      && [box.x, box.y, box.width, box.height].every(Number.isFinite)
      && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
      && box.x + box.width <= dimensions.width + .5
      && box.y + box.height <= dimensions.height + .5;
    bboxOverlay.hidden = !visible;
    if (!visible) return;
    bboxOverlay.style.left = `${box.x / dimensions.width * 100}%`;
    bboxOverlay.style.top = `${box.y / dimensions.height * 100}%`;
    bboxOverlay.style.width = `${box.width / dimensions.width * 100}%`;
    bboxOverlay.style.height = `${box.height / dimensions.height * 100}%`;
  }

  function updatePagePreview() {
    const dimensions = pageDimensions(state.previewPage);
    $('#previous-page').disabled = !pageDimensions(state.previewPage - 1);
    $('#next-page').disabled = !pageDimensions(state.previewPage + 1);
    if (!dimensions) {
      pageCanvas.hidden = true;
      pagePlaceholder.hidden = false;
      pagePlaceholder.textContent = '这份试卷没有可预览的页面资源。';
      return;
    }
    const url = pageImageUrl(dimensions.page);
    if (!url) {
      pageCanvas.hidden = true;
      pagePlaceholder.hidden = false;
      pagePlaceholder.textContent = `第 ${state.previewPage} 页的图片地址无效。`;
      return;
    }
    pagePlaceholder.hidden = true;
    pageCanvas.hidden = false;
    pageCanvas.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    if (pageImage.src !== url) pageImage.src = url;
    pageImage.alt = `原卷第 ${state.previewPage} 页`;
    updateBBoxOverlay();
  }

  function setPreviewPage(value) {
    const target = Math.floor(number(value));
    if (!pageDimensions(target)) return;
    state.previewPage = target;
    pageSelect.value = String(target);
    updatePagePreview();
  }

  async function responseMessage(response) {
    try {
      const payload = await response.clone().json();
      return text(payload?.error ?? payload?.message, 1000) || `请求失败（HTTP ${response.status}）`;
    } catch {
      return `请求失败（HTTP ${response.status}）`;
    }
  }

  function applyReviewDocument(document, manifest, responseEtag = '', preferredKey = '') {
    if (!document || document.schemaVersion !== 'cet-review/1' || document.examId !== state.examId) {
      throw new Error('服务器返回了不兼容的复核数据。');
    }
    const revision = document.revision;
    if (!Number.isInteger(revision) || revision < 0) throw new Error('复核版本号无效。');
    state.review = document;
    state.manifest = manifest;
    state.revision = revision;
    state.etag = text(responseEtag || document.etag, 100);
    if (!/^"review-r\d+"$/.test(state.etag)) throw new Error('服务器没有返回可用的复核 ETag。');
    state.questions = listFrom(document.questions, 'questions').map(normalizeQuestion).filter(Boolean);
    state.answers = listFrom(document.answers, 'answers').map(normalizeAnswer).filter(Boolean);
    state.issues = listFrom(document.issues, 'issues').map(normalizeIssue).filter(Boolean);
    buildItems();
    renderPageChoices();
    renderMetrics();
    renderQueue();
    $('#exam-title').textContent = text(manifest?.title, 180) || `试卷 ${state.examId}`;
    $('#revision-label').textContent = `复核版本 r${state.revision} · ${state.issues.length} 项待处理`;
    const reader = $('#open-reader');
    reader.href = `reader.html?paper=${encodeURIComponent(state.examId)}`;
    reader.removeAttribute('aria-disabled');
    reader.removeAttribute('tabindex');
    window.document.title = `${text(manifest?.title, 100) || '试卷'} · 解析复核`;
    clearFatal();
    state.conflicted = false;
    conflictBanner.hidden = true;
    setBusy(false);
    setDirty(false);

    const preferred = state.items.find((item) => item.key === preferredKey);
    const first = filteredItems()[0] || state.items[0];
    if (preferred || first) populateForm(preferred || first);
    else {
      state.activeKey = '';
      form.hidden = true;
      editorEmpty.hidden = false;
    }
  }

  async function loadReview({ preserveSelection = true, discardConfirmed = false } = {}) {
    if (!state.examId) {
      showFatal('地址中缺少有效的 exam 参数。请从“最近导入的试卷”进入复核页面。');
      return;
    }
    if (!discardConfirmed && !confirmDiscard()) return;
    const generation = ++state.loadGeneration;
    const preferredKey = preserveSelection && !state.activeIsNew ? state.activeKey : '';
    setBusy(true, 'load');
    try {
      const [reviewResponse, manifestResponse] = await Promise.all([
        fetch(state.reviewUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
        fetch(`/api/exams/${state.examId}/manifest`, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      ]);
      if (generation !== state.loadGeneration) return;
      if (!reviewResponse.ok) throw new Error(await responseMessage(reviewResponse));
      if (!manifestResponse.ok) throw new Error(await responseMessage(manifestResponse));
      const [document, manifest] = await Promise.all([reviewResponse.json(), manifestResponse.json()]);
      if (generation !== state.loadGeneration) return;
      applyReviewDocument(document, manifest, reviewResponse.headers.get('ETag') || '', preferredKey);
    } catch (error) {
      if (generation !== state.loadGeneration) return;
      setBusy(false);
      showFatal(error?.message || '读取复核数据失败。');
    }
  }

  function collectOptions() {
    const options = [];
    const seen = new Set();
    for (const row of $$('[data-option-row]', optionEditor)) {
      const label = text($('[data-option-label]', row)?.value, 1).toUpperCase();
      const optionText = text($('[data-option-text]', row)?.value, 4000);
      if (!OPTION_LABELS.includes(label)) throw new Error('选项标签必须是 A–O 的单个字母。');
      if (seen.has(label)) throw new Error(`选项 ${label} 重复，请保留一项。`);
      seen.add(label);
      options.push({ label, text: optionText });
    }
    return options;
  }

  function questionFormSnapshot() {
    return {
      questionId: $('#question-id')?.value ?? '',
      number: $('#question-number')?.value ?? '',
      type: questionType?.value ?? '',
      stem: $('#question-stem')?.value ?? '',
      page: $('#question-page')?.value ?? '',
      bbox: [$('#bbox-x')?.value ?? '', $('#bbox-y')?.value ?? '', $('#bbox-width')?.value ?? '', $('#bbox-height')?.value ?? ''],
      options: $$('[data-option-row]', optionEditor).map((row) => [
        $('[data-option-label]', row)?.value ?? '',
        $('[data-option-text]', row)?.value ?? '',
      ]),
    };
  }

  function answerFormSnapshot() {
    return {
      answer: $('#answer-value')?.value ?? '',
      explanation: $('#answer-explanation')?.value ?? '',
    };
  }

  function serializeFormSnapshot(snapshot) {
    return JSON.stringify(snapshot);
  }

  function questionFormChanged() {
    return serializeFormSnapshot(questionFormSnapshot()) !== state.questionFormBaseline;
  }

  function answerFormChanged() {
    return serializeFormSnapshot(answerFormSnapshot()) !== state.answerFormBaseline;
  }

  function hasSubstantiveFormChanges() {
    return questionFormChanged() || answerFormChanged() || Boolean(removeAnswerWithSave?.checked);
  }

  function setAnswerRemovalMode(removeRequested = Boolean(removeAnswerWithSave?.checked)) {
    const answerValue = $('#answer-value');
    const explanation = $('#answer-explanation');
    if (answerValue) answerValue.disabled = removeRequested;
    if (explanation) explanation.disabled = removeRequested;
    answerRemovalControl?.classList.toggle('is-selected', removeRequested);
  }

  function collectQuestion() {
    const questionId = text($('#question-id').value, 32);
    const idMatch = SAFE_QUESTION_ID.exec(questionId);
    if (!idMatch) throw new Error('Question ID 必须类似 q26、writing-1 或 translation-1。');
    if (state.activeIsNew && state.questions.some((question) => question.questionId === questionId)) {
      throw new Error(`${questionId} 已存在，请换一个 Question ID。`);
    }
    if (!state.activeIsNew && state.activeKey && questionId !== state.activeKey) {
      throw new Error('已有题目的 Question ID 不能修改；如需更换，请删除后重新新增。');
    }
    const type = questionType.value;
    if (!QUESTION_TYPES.has(type)) throw new Error('请选择有效题型。');
    let questionNumber;
    if (idMatch[1]) {
      questionNumber = Number($('#question-number').value);
      if (!Number.isInteger(questionNumber) || questionNumber !== Number(idMatch[1])) {
        throw new Error(`${questionId} 的题号必须填写整数 ${idMatch[1]}。`);
      }
      if (LONG_TYPES.has(type)) throw new Error(`${questionId} 不能使用写作或翻译题型。`);
    } else {
      questionNumber = text($('#question-number').value, 32);
      if (!questionNumber) throw new Error('请填写题号显示文字。');
      if (type !== idMatch[2]) throw new Error(`${questionId} 必须使用${typeLabel(idMatch[2])}题型。`);
    }
    const page = Number($('#question-page').value);
    const dimensions = pageDimensions(page);
    if (!Number.isInteger(page) || !dimensions) throw new Error('页码必须来自当前原卷。');
    const box = formBBox();
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) {
      throw new Error('请填写有效的正数题目坐标。');
    }
    if (box.x + box.width > dimensions.width + .5 || box.y + box.height > dimensions.height + .5) {
      throw new Error(`题目坐标超出第 ${page} 页范围（${dimensions.width} × ${dimensions.height}）。`);
    }
    const stem = text($('#question-stem').value, 12000);
    if (!stem && LONG_TYPES.has(type)) throw new Error(`${typeLabel(type)}题干不能为空。`);
    const options = collectOptions();
    if (['single_choice', 'matching'].includes(type) && options.length < 2) throw new Error(`${typeLabel(type)}至少需要两个选项。`);
    if (LONG_TYPES.has(type) && options.length) throw new Error(`${typeLabel(type)}不能包含选项，请先移除全部选项。`);
    if (type === 'unknown' && options.length === 1) throw new Error('待确认题型不能只保留一个选项。');
    return {
      questionId,
      number: questionNumber,
      type,
      page,
      bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
      stem,
      options,
    };
  }

  function collectReason() {
    const reason = text($('#review-reason').value, 500);
    if (reason.length < 3 || GENERIC_REASONS.has(reason.toLocaleLowerCase('zh-CN'))) {
      throw new Error('请填写具体修改理由，例如核对了哪一页、补全或修正了什么。');
    }
    return reason;
  }

  function collectSaveOperations() {
    const item = state.activeItem;
    if (!item) throw new Error('请先选择一个复核项目。');
    const questionPending = Boolean(item.question?.reviewRequired)
      || item.issues.some((issue) => issue.kind === 'question_review');
    const answerPending = Boolean(item.answer?.reviewRequired)
      || item.issues.some((issue) => issue.kind === 'answer_review' || issue.kind === 'answer_conflict');
    const needsQuestionUpsert = state.activeIsNew || !item.question || questionFormChanged() || questionPending;
    const question = needsQuestionUpsert ? collectQuestion() : item.question;
    if (!question) throw new Error('缺失题目必须先补录题目内容。');

    const operations = [];
    if (needsQuestionUpsert) operations.push({ op: 'upsertQuestion', question });

    const removalRequested = Boolean(removeAnswerWithSave?.checked);
    const answerValue = text($('#answer-value').value, 1).toUpperCase();
    const explanation = text($('#answer-explanation').value, 12000);
    const answerChanged = answerFormChanged();
    if (removalRequested) {
      if (!item.answer) throw new Error('当前项目没有可移除的已有答案。');
      operations.push({ op: 'removeAnswer', questionId: question.questionId });
    } else if (answerValue) {
      if (!['single_choice', 'matching'].includes(question.type)) throw new Error('只有选择或匹配题可以填写正确答案。');
      if (!question.options.some((option) => option.label === answerValue)) throw new Error('正确答案必须匹配当前题目的一个选项标签。');
      if (!item.answer || answerChanged || answerPending) {
        operations.push({
          op: 'upsertAnswer',
          answer: { questionId: question.questionId, answer: answerValue, explanation },
        });
      }
    } else {
      if (explanation) throw new Error('填写官方解析时也必须填写正确答案。');
      if (item.answer) throw new Error('已有答案不能通过清空输入框删除；请勾选“保存时同时移除已有答案”。');
    }

    if (item.answer && !removalRequested && !answerValue) {
      throw new Error('已有答案不能为空；如需删除，请明确勾选移除答案。');
    }
    if (!operations.length) {
      throw new Error(answerPending
        ? '该答案仍待确认，请填写可确认的答案后保存。'
        : '当前内容没有变化，也没有待确认项目，无需创建新版本。');
    }
    return { operations, questionId: question.questionId };
  }

  function isRevisionConflict(status, message) {
    return status === 412 || (status === 409 && /revision|版本|etag|changed/i.test(message));
  }

  async function patchReview(operations, reason, successMessage, preferredKey = '') {
    if (state.busy || state.conflicted) return;
    setFormError('');
    setBusy(true);
    try {
      const response = await fetch(state.reviewUrl, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'If-Match': state.etag,
        },
        body: JSON.stringify({
          schemaVersion: 'cet-review/1',
          baseRevision: state.revision,
          reason,
          operations,
        }),
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        if (isRevisionConflict(response.status, message)) {
          state.conflicted = true;
          conflictBanner.hidden = false;
          $('#conflict-message').textContent = message || '为避免覆盖其他修改，请读取最新版本后再编辑。';
          window.setTimeout(() => $('#reload-conflict')?.focus(), 0);
          throw Object.assign(new Error(message), { handled: true });
        }
        throw new Error(message);
      }
      const document = await response.json();
      const responseEtag = response.headers.get('ETag') || document?.etag || '';
      state.conflicted = false;
      setDirty(false);
      applyReviewDocument(document, state.manifest, responseEtag, preferredKey);
      showToast(successMessage);
    } catch (error) {
      setBusy(false);
      if (!error?.handled) setFormError(error?.message || '保存复核失败，请稍后重试。');
    }
  }

  async function saveCurrent(event) {
    event.preventDefault();
    if (state.busy || state.conflicted) return;
    try {
      const { operations, questionId } = collectSaveOperations();
      const reason = collectReason();
      await patchReview(operations, reason, `${questionId} 已保存为新的复核版本`, questionId);
    } catch (error) {
      setFormError(error?.message || '请检查表单内容。');
    }
  }

  async function removeCurrentQuestion() {
    const item = state.items.find((candidate) => candidate.key === state.activeKey);
    if (!item?.question || state.busy || state.conflicted) return;
    if (hasSubstantiveFormChanges() && !window.confirm('当前题目或答案还有未保存修改。继续移除题目会放弃这些修改，确定继续吗？')) return;
    let reason;
    try { reason = collectReason(); } catch (error) { setFormError(error.message); return; }
    const hasAnswer = Boolean(item.answer);
    const detail = hasAnswer ? '该题的答案也会一并移除。' : '这个操作会创建一个新的复核版本。';
    if (!window.confirm(`确定移除 ${item.questionId} 吗？${detail}`)) return;
    await patchReview(
      [{ op: 'removeQuestion', questionId: item.questionId, cascadeAnswer: hasAnswer }],
      reason,
      `${item.questionId} 已移除`,
      ''
    );
  }

  async function removeCurrentAnswer() {
    const item = state.items.find((candidate) => candidate.key === state.activeKey);
    if (!item?.answer || state.busy || state.conflicted) return;
    if (hasSubstantiveFormChanges() && !window.confirm('当前题目或答案还有未保存修改。若要连同题目修改一起移除答案，请勾选“保存时同时移除已有答案”；继续单独移除将放弃当前修改。确定继续吗？')) return;
    let reason;
    try { reason = collectReason(); } catch (error) { setFormError(error.message); return; }
    if (!window.confirm(`确定移除 ${item.questionId} 的答案记录吗？题目本身会保留。`)) return;
    await patchReview(
      [{ op: 'removeAnswer', questionId: item.questionId }],
      reason,
      `${item.questionId} 的答案已移除`,
      item.questionId
    );
  }

  function addNextOption() {
    const rows = $$('[data-option-row]', optionEditor);
    if (rows.length >= 15) {
      showToast('每题最多 15 个选项');
      return;
    }
    const used = new Set(rows.map((row) => text($('[data-option-label]', row)?.value, 1).toUpperCase()));
    const label = [...OPTION_LABELS].find((candidate) => !used.has(candidate));
    const empty = $('.option-empty', optionEditor);
    empty?.remove();
    appendOptionRow({ label: label || '', text: '' });
    $('[data-option-text]', optionEditor.lastElementChild)?.focus();
    setDirty(true);
  }

  function handleTypeChange() {
    const previous = questionType.dataset.previousValue || 'unknown';
    const next = questionType.value;
    if (LONG_TYPES.has(next) && $$('[data-option-row]', optionEditor).length) {
      if (!window.confirm(`${typeLabel(next)}不能包含选项，是否清空当前选项？`)) {
        questionType.value = previous;
        return;
      }
      renderOptions([]);
    }
    questionType.dataset.previousValue = questionType.value;
    setDirty(true);
  }

  queueList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-item-key]');
    if (button) selectItem(button.dataset.itemKey);
  });
  queueList?.addEventListener('keydown', (event) => {
    const current = event.target.closest('[data-item-key]');
    if (!current || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...queueList.querySelectorAll('[data-item-key]')];
    const index = buttons.indexOf(current);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const targetIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1)
          : Math.max(0, index - 1);
    buttons[targetIndex].focus();
  });
  queueList?.addEventListener('focusin', (event) => {
    const current = event.target.closest('[data-item-key]');
    if (!current) return;
    queueList.querySelectorAll('[data-item-key]').forEach((button) => {
      button.tabIndex = button === current ? 0 : -1;
    });
  });
  $('#filter-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    $$('[data-filter]', $('#filter-tabs')).forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
    renderQueue();
  });
  $('#review-search')?.addEventListener('input', (event) => {
    state.search = text(event.currentTarget.value, 80);
    renderQueue();
  });
  form?.addEventListener('submit', saveCurrent);
  form?.addEventListener('input', (event) => {
    if (state.populating) return;
    if (event.target.matches('#question-page, #bbox-x, #bbox-y, #bbox-width, #bbox-height')) {
      if (event.target.id === 'question-page' && pageDimensions(Number(event.target.value))) setPreviewPage(Number(event.target.value));
      updateBBoxOverlay();
    }
    if (event.target.matches('[data-option-label]')) event.target.value = event.target.value.toUpperCase().replace(/[^A-O]/g, '').slice(0, 1);
    if (event.target.matches('#answer-value')) event.target.value = event.target.value.toUpperCase().replace(/[^A-O]/g, '').slice(0, 1);
    if (event.target.matches('#question-id')) {
      const match = /^q(\d{1,3})$/.exec(event.target.value.trim());
      if (match) $('#question-number').value = match[1];
    }
    setDirty(true);
  });
  questionType?.addEventListener('change', handleTypeChange);
  optionEditor?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-option]');
    if (!remove) return;
    remove.closest('[data-option-row]')?.remove();
    if (!$$('[data-option-row]', optionEditor).length) renderOptions([]);
    setDirty(true);
  });
  $('#add-option')?.addEventListener('click', addNextOption);
  $('#add-question')?.addEventListener('click', beginNewQuestion);
  $('#reset-form')?.addEventListener('click', () => {
    if (!confirmDiscard()) return;
    const item = state.items.find((candidate) => candidate.key === state.activeKey);
    if (item && !state.activeIsNew) populateForm(item);
    else {
      setDirty(false);
      beginNewQuestion();
    }
  });
  $('#remove-question')?.addEventListener('click', removeCurrentQuestion);
  $('#remove-answer')?.addEventListener('click', removeCurrentAnswer);
  removeAnswerWithSave?.addEventListener('change', () => {
    if (state.populating) return;
    setAnswerRemovalMode();
    setDirty(true);
  });
  pageSelect?.addEventListener('change', (event) => setPreviewPage(event.currentTarget.value));
  $('#previous-page')?.addEventListener('click', () => setPreviewPage(state.previewPage - 1));
  $('#next-page')?.addEventListener('click', () => setPreviewPage(state.previewPage + 1));
  $('#reload-review')?.addEventListener('click', () => loadReview({ preserveSelection: true }));
  $('#retry-load')?.addEventListener('click', () => loadReview({ preserveSelection: false, discardConfirmed: true }));
  $('#reload-conflict')?.addEventListener('click', () => {
    if (!window.confirm('读取最新版本会放弃当前未保存的表单修改，确定继续吗？')) return;
    state.conflicted = false;
    conflictBanner.hidden = true;
    setDirty(false);
    loadReview({ preserveSelection: true, discardConfirmed: true });
  });
  $('#open-reader')?.addEventListener('click', (event) => {
    if (event.currentTarget.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
  pageImage?.addEventListener('error', () => {
    pageCanvas.hidden = true;
    pagePlaceholder.hidden = false;
    pagePlaceholder.textContent = `第 ${state.previewPage} 页图片加载失败。`;
  });
  addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !form.hidden) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  loadReview({ preserveSelection: false, discardConfirmed: true });
})();
