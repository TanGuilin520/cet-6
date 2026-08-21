(() => {
  'use strict';

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const form = $('#exam-upload-form');
  const processingCard = $('#processing-card');
  const processingEmpty = $('#processing-empty');
  const processingDetail = $('#processing-detail');
  const submitButton = $('#submit-upload');
  const resetButton = $('#reset-upload');
  const formError = $('#form-error');
  const retryButton = $('#retry-status');
  const recentList = $('#recent-exams');
  const refreshButton = $('#refresh-exams');
  const stageOrder = ['upload', 'inspect', 'render', 'text', 'package'];
  const statusLabels = {
    queued: '等待处理',
    processing: '处理中',
    ready: '已完成',
    failed: '处理失败',
    uploading: '正在上传',
  };
  const stageMeta = {
    upload: ['正在接收文件', '正在保存原卷和可选附件。'],
    inspect: ['正在检查试卷', '正在验证页面，并判断是否存在可用文字层。'],
    render: ['正在还原页面', '正在把 PDF 页面转换为阅读器使用的高清图像。'],
    text: ['正在提取文字', '正在建立单词坐标；扫描页会自动切换到 OCR。'],
    package: ['正在整理资源', '正在生成试卷清单并完成入库。'],
  };
  const stageAliases = {
    upload: ['upload', 'uploaded', 'receiving', 'received', 'saving', 'queued'],
    inspect: ['inspect', 'inspection', 'validate', 'validating', 'analyse', 'analyze', 'checking', 'checked'],
    render: ['render', 'rendering', 'convert', 'converting', 'pages', 'images', 'rasterize'],
    text: ['text', 'extract', 'extracting', 'extraction', 'ocr', 'recognize', 'recognizing', 'words', 'parsing', 'questions', 'answers'],
    package: ['package', 'packaging', 'manifest', 'finalize', 'finalizing', 'index', 'indexing', 'ready', 'complete', 'completed'],
  };
  const pdfExtensions = new Set(['pdf']);
  const audioExtensions = new Set(['mp3', 'wav', 'm4a']);
  let pollTimer = 0;
  let pollController = null;
  let pollGeneration = 0;
  let pollFailures = 0;
  let lastStatusUrl = '';
  let activeExamId = '';
  let uploadRequest = null;

  function getExtension(filename) {
    const parts = String(filename || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
    return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function firstNumber() {
    for (const value of arguments) {
      if (value === null || value === undefined || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function normalizeProgress(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return clamp(fallback, 0, 100);
    const number = Number(value);
    if (!Number.isFinite(number)) return clamp(fallback, 0, 100);
    return clamp(number > 0 && number <= 1 ? number * 100 : number, 0, 100);
  }

  function confidencePercent(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return clamp(number >= 0 && number <= 1 ? number * 100 : number, 0, 100);
  }

  function reviewCountFrom(value) {
    const result = value?.result || {};
    const counts = result.reviewCounts || value?.reviewCounts || value?.reviewSummary || {};
    if (typeof counts === 'number') return Math.max(0, Math.floor(counts));
    const direct = firstNumber(
      counts.pending,
      counts.needsReview,
      counts.lowConfidence,
      counts.low_confidence,
      value?.reviewCount,
      value?.lowConfidenceCount
    );
    if (direct !== null) return Math.max(0, Math.floor(direct));
    if (counts && typeof counts === 'object') {
      let reviews = 0;
      let recognized = false;
      const addReviewGroup = (group) => {
        if (!group || typeof group !== 'object') return;
        const suggested = firstNumber(group.suggestedReview, group.suggested_review) || 0;
        const manual = firstNumber(group.manualReview, group.manual_review) || 0;
        const pending = firstNumber(group.pending, group.needsReview, group.lowConfidence, group.low_confidence) || 0;
        const unresolved = firstNumber(group.unresolved, group.unresolvedQuestions, group.unresolved_questions) || 0;
        if (
          'suggestedReview' in group || 'suggested_review' in group
          || 'manualReview' in group || 'manual_review' in group
          || 'pending' in group || 'needsReview' in group
          || 'lowConfidence' in group || 'low_confidence' in group
          || 'unresolved' in group || 'unresolvedQuestions' in group || 'unresolved_questions' in group
        ) {
          reviews += suggested + manual + pending + unresolved;
          recognized = true;
        }
      };
      addReviewGroup(counts);
      Object.entries(counts).forEach(([key, group]) => {
        if (group && typeof group === 'object') addReviewGroup(group);
        else if (/conflict/i.test(key) && Number.isFinite(Number(group))) {
          reviews += Number(group);
          recognized = true;
        }
      });
      if (recognized) return Math.max(0, Math.floor(reviews));
      const total = firstNumber(counts.total);
      if (total !== null) return Math.max(0, Math.floor(total));
    }
    return null;
  }

  function resolveStage(stage, status = '') {
    const value = String(stage || status || '').toLowerCase().replace(/[_\s-]+/g, '');
    if (String(status).toLowerCase() === 'ready') return 'package';
    for (const key of stageOrder) {
      if (stageAliases[key].some((alias) => value.includes(alias.replace(/[_\s-]+/g, '')))) return key;
    }
    return status === 'queued' ? 'upload' : 'inspect';
  }

  function modeLabel(mode) {
    const value = String(mode || '').toLowerCase();
    if (!value) return '检测中';
    if (value.includes('mixed') || (value.includes('ocr') && value.includes('text'))) return '文字层 + OCR';
    if (value.includes('ocr') || value.includes('scan')) return 'OCR 识别';
    if (value.includes('native') || value.includes('text') || value.includes('pdf')) return 'PDF 原生文字层';
    if (value === 'none') return '未识别到文字';
    return String(mode);
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function showFormError(message) {
    if (!formError) return;
    formError.textContent = String(message || '上传失败，请稍后重试。');
    formError.hidden = false;
    formError.focus();
  }

  function clearFormError() {
    if (!formError) return;
    formError.hidden = true;
    formError.textContent = '';
  }

  function setFieldError(input, message) {
    if (!input) return;
    const field = input.closest('.file-field, .text-field');
    const error = field?.querySelector('.field-error');
    field?.classList.toggle('is-invalid', Boolean(message));
    input.setAttribute('aria-invalid', String(Boolean(message)));
    if (error) {
      error.textContent = String(message || '');
      error.hidden = !message;
    }
  }

  function updateFileField(input) {
    const field = input.closest('.file-field');
    const file = input.files?.[0];
    const filename = $('[data-file-name]', field);
    field?.classList.toggle('has-file', Boolean(file));
    if (!filename) return;
    if (file) {
      filename.textContent = file.name + (file.size ? ' · ' + formatBytes(file.size) : '');
    } else if (input.id === 'exam-pdf') {
      filename.textContent = '点击浏览 PDF 文件';
    } else if (input.id === 'answer-pdf') {
      filename.textContent = '选择 PDF';
    } else {
      filename.textContent = 'MP3 / WAV / M4A';
    }
  }

  function validateFile(input, extensions, label, required = false) {
    const file = input?.files?.[0];
    if (!file) {
      const message = required ? '请选择' + label + '。' : '';
      setFieldError(input, message);
      return !required;
    }
    if (!extensions.has(getExtension(file.name))) {
      const allowed = [...extensions].map((item) => item.toUpperCase()).join('、');
      setFieldError(input, label + '仅支持 ' + allowed + ' 格式。');
      return false;
    }
    setFieldError(input, '');
    return true;
  }

  function validateForm() {
    clearFormError();
    const title = $('#exam-title');
    setFieldError(title, '');
    const checks = [
      validateFile($('#exam-pdf'), pdfExtensions, '试卷 PDF', true),
      validateFile($('#answer-pdf'), pdfExtensions, '答案 PDF'),
      validateFile($('#exam-audio'), audioExtensions, '听力音频'),
    ];
    const valid = checks.every(Boolean);
    if (!valid) {
      const firstInvalid = $('[aria-invalid="true"]', form);
      firstInvalid?.focus();
    }
    return valid;
  }

  function setFormBusy(busy) {
    $$('input, button', form).forEach((control) => { control.disabled = busy; });
    if (submitButton) {
      const label = $('span', submitButton);
      setText(label, busy ? '正在生成试卷…' : '上传并生成试卷');
    }
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { error: text.slice(0, 500) }; }
    }
    if (!response.ok) {
      const message = typeof data.error === 'string'
        ? data.error
        : typeof data.message === 'string'
          ? data.message
          : '请求失败（' + response.status + '）';
      throw new Error(message);
    }
    return data;
  }

  function uploadFormData(body, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      uploadRequest = request;
      request.open('POST', '/api/exams/upload');
      request.setRequestHeader('Accept', 'application/json');
      request.upload.addEventListener('progress', (event) => {
        if (typeof onProgress === 'function') onProgress(event.loaded, event.total, event.lengthComputable);
      });
      request.addEventListener('load', () => {
        let data = {};
        if (request.responseText) {
          try { data = JSON.parse(request.responseText); }
          catch { data = { error: request.responseText.slice(0, 500) }; }
        }
        if (request.status >= 200 && request.status < 300) {
          resolve(data);
          return;
        }
        const message = typeof data.error === 'string'
          ? data.error
          : typeof data.message === 'string'
            ? data.message
            : '请求失败（' + request.status + '）';
        reject(new Error(message));
      });
      request.addEventListener('error', () => reject(new Error('无法连接试卷上传服务。')));
      request.addEventListener('abort', () => reject(new DOMException('上传已取消。', 'AbortError')));
      request.addEventListener('loadend', () => {
        if (uploadRequest === request) uploadRequest = null;
      });
      request.send(body);
    });
  }

  function safeStatusUrl(value) {
    if (!value) return '';
    const target = new URL(String(value), location.href);
    if (target.origin !== location.origin) throw new Error('服务返回了无效的状态地址。');
    return target.pathname + target.search;
  }

  function stopPolling() {
    pollGeneration += 1;
    clearTimeout(pollTimer);
    pollTimer = 0;
    pollController?.abort();
    pollController = null;
  }

  function startProcessingView() {
    if (processingEmpty) processingEmpty.hidden = true;
    if (processingDetail) {
      processingDetail.hidden = false;
      processingDetail.setAttribute('aria-busy', 'true');
    }
    if (processingCard) processingCard.dataset.state = 'processing';
    $('#processing-error').hidden = true;
    $('#processing-ready').hidden = true;
    retryButton.hidden = true;
    setText($('#metric-pages'), '–');
    setText($('#metric-words'), '–');
    setText($('#metric-confidence'), '–');
    setText($('#metric-review'), '–');
    setText($('#ocr-mode'), '检测中');
  }

  function updateStages(stageKey, ready = false) {
    const index = stageOrder.indexOf(stageKey);
    $$('[data-stage-key]', $('#stage-list')).forEach((item) => {
      const itemIndex = stageOrder.indexOf(item.dataset.stageKey);
      item.classList.toggle('is-complete', ready || itemIndex < index);
      item.classList.toggle('is-active', !ready && itemIndex === index);
    });
  }

  function updateMetrics(data) {
    const result = data?.result || {};
    const quality = result.quality || data?.quality || {};
    const pages = firstNumber(result.pageCount, data?.pageCount, data?.pages);
    const words = firstNumber(result.wordCount, data?.wordCount, data?.words);
    const confidence = confidencePercent(firstNumber(
      result.averageConfidence,
      result.confidence,
      data?.averageConfidence,
      data?.confidence,
      quality.averageConfidence,
      quality.confidence
    ));
    const reviews = reviewCountFrom(data);
    const mode = result.ocrMode || result.textMode || data?.ocrMode || data?.textMode || quality.ocrMode || quality.mode;
    if (pages !== null) setText($('#metric-pages'), String(Math.max(0, Math.floor(pages))));
    if (words !== null) setText($('#metric-words'), Number(words).toLocaleString('zh-CN'));
    if (confidence !== null) setText($('#metric-confidence'), Math.round(confidence) + '%');
    if (reviews !== null) setText($('#metric-review'), String(reviews));
    if (mode) setText($('#ocr-mode'), modeLabel(mode));
  }

  function updateProcessing(data) {
    const status = String(data?.status || 'processing').toLowerCase();
    const stageKey = resolveStage(data?.stage, status);
    const stageIndex = Math.max(0, stageOrder.indexOf(stageKey));
    const fallbackProgress = status === 'ready' ? 100 : stageIndex * 20 + (status === 'queued' ? 2 : 8);
    const progress = normalizeProgress(data?.progress, fallbackProgress);
    const fallback = stageMeta[stageKey] || stageMeta.inspect;
    const title = status === 'ready' ? '试卷已经生成' : status === 'failed' ? '处理没有完成' : fallback[0];
    setText($('#stage-title'), title);
    setText($('#stage-message'), String(data?.message || fallback[1]));
    setText($('#status-badge'), statusLabels[status] || '处理中');
    setText($('#progress-value'), Math.round(progress) + '%');
    $('#progress-bar').style.width = progress + '%';
    $('#progress-track').setAttribute('aria-valuenow', String(Math.round(progress)));
    updateStages(stageKey, status === 'ready');
    updateMetrics(data);
    processingCard.dataset.state = status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : 'processing';
  }

  function setProcessingError(message, allowRetry = false) {
    const panel = $('#processing-error');
    if (!panel) return;
    processingCard.dataset.state = 'failed';
    processingDetail?.setAttribute('aria-busy', 'false');
    setText($('#status-badge'), allowRetry ? '连接中断' : '处理失败');
    setText($('#processing-error-message'), String(message || '处理失败，请检查文件后重新上传。'));
    retryButton.hidden = !allowRetry;
    panel.hidden = false;
    setFormBusy(false);
  }

  function manifestMetrics(manifest) {
    const pages = Array.isArray(manifest?.pages) ? manifest.pages : [];
    const words = pages.flatMap((page) => Array.isArray(page.words) ? page.words : []);
    const confidences = words
      .map((word) => confidencePercent(firstNumber(word?.ocrConfidence, word?.confidence)))
      .filter((value) => value !== null);
    const explicitConfidence = confidencePercent(firstNumber(
      manifest?.averageConfidence,
      manifest?.confidence,
      manifest?.quality?.averageConfidence,
      manifest?.quality?.confidence
    ));
    const confidence = explicitConfidence !== null
      ? explicitConfidence
      : confidences.length
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null;
    const explicitReviews = reviewCountFrom(manifest);
    const flagged = words.filter((word) => word?.needsReview || word?.reviewRequired || word?.lowConfidence).length;
    const modes = new Set();
    [
      manifest?.ocrMode,
      manifest?.textMode,
      manifest?.quality?.mode,
      manifest?.extraction?.engine,
      ...pages.map((page) => page?.ocrMode || page?.textMode || page?.textSource || page?.source),
    ].filter(Boolean).forEach((mode) => modes.add(modeLabel(mode)));
    let mode = '';
    if (modes.size > 1) mode = '文字层 + OCR';
    else if (modes.size === 1) mode = [...modes][0];
    return {
      pages: pages.length || null,
      words: words.length || null,
      confidence,
      reviews: explicitReviews !== null ? explicitReviews : flagged || null,
      mode,
    };
  }

  async function hydrateResultMetrics(result) {
    const resources = [
      ['manifest', result?.manifestUrl],
      ['questions', result?.questionsUrl],
      ['answers', result?.answersUrl],
    ].filter((entry) => entry[1]);
    const documents = {};
    await Promise.all(resources.map(async ([name, rawUrl]) => {
      try { documents[name] = await requestJson(safeStatusUrl(rawUrl)); }
      catch { documents[name] = null; }
    }));

    if (documents.manifest) {
      const metrics = manifestMetrics(documents.manifest);
      if (metrics.pages !== null) setText($('#metric-pages'), String(metrics.pages));
      if (metrics.words !== null) setText($('#metric-words'), metrics.words.toLocaleString('zh-CN'));
      if (metrics.confidence !== null) setText($('#metric-confidence'), Math.round(metrics.confidence) + '%');
      if (metrics.mode) setText($('#ocr-mode'), metrics.mode);
    }

    const reviewItems = [
      ...(Array.isArray(documents.questions?.questions) ? documents.questions.questions : []),
      ...(Array.isArray(documents.answers?.answers) ? documents.answers.answers : []),
    ];
    const confidences = reviewItems
      .map((item) => confidencePercent(item?.confidence))
      .filter((value) => value !== null);
    if (confidences.length) {
      const average = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
      setText($('#metric-confidence'), Math.round(average) + '%');
    }
    const reviews = reviewCountFrom({ result });
    if (reviews !== null) setText($('#metric-review'), String(reviews));
    if ($('#ocr-mode')?.textContent === '检测中') setText($('#ocr-mode'), '已完成文字提取');
  }

  async function completeProcessing(data) {
    stopPolling();
    updateProcessing({ ...data, status: 'ready', progress: 100 });
    processingDetail?.setAttribute('aria-busy', 'false');
    const examId = String(data?.examId || activeExamId || '').trim();
    activeExamId = examId;
    const reviews = reviewCountFrom(data);
    const readySummary = reviews && reviews > 0
      ? '已生成完整卷，其中 ' + reviews + ' 项识别结果建议复核。'
      : '页面与文字层已生成，现在可以进入阅读器检查版式。';
    setText($('#ready-summary'), readySummary);
    const openReader = $('#open-reader');
    if (openReader && examId) openReader.href = 'reader.html?paper=' + encodeURIComponent(examId);
    $('#processing-error').hidden = true;
    $('#processing-ready').hidden = false;
    $('#processing-ready').focus();
    setFormBusy(false);
    hydrateResultMetrics(data?.result || {});
    loadRecentExams();
  }

  function schedulePoll(statusUrl, generation) {
    pollTimer = window.setTimeout(() => pollStatus(statusUrl, generation), 1200);
  }

  async function pollStatus(statusUrl, generation = pollGeneration) {
    if (!statusUrl || generation !== pollGeneration) return;
    pollController = new AbortController();
    const timeout = window.setTimeout(() => pollController?.abort(), 20000);
    try {
      const data = await requestJson(statusUrl, { signal: pollController.signal });
      if (generation !== pollGeneration) return;
      pollFailures = 0;
      activeExamId = String(data?.examId || activeExamId || '');
      updateProcessing(data);
      const status = String(data?.status || '').toLowerCase();
      if (status === 'ready') {
        await completeProcessing(data);
        return;
      }
      if (status === 'failed') {
        stopPolling();
        setProcessingError(data?.error || data?.message || '服务未能生成这套试卷。');
        return;
      }
      schedulePoll(statusUrl, generation);
    } catch (error) {
      if (generation !== pollGeneration) return;
      pollFailures += 1;
      if (error?.name === 'AbortError' && pollFailures < 4) {
        setText($('#stage-message'), '状态请求超时，正在重新连接…');
        schedulePoll(statusUrl, generation);
      } else if (pollFailures < 4) {
        setText($('#stage-message'), '暂时无法读取进度，正在进行第 ' + pollFailures + ' 次重试…');
        schedulePoll(statusUrl, generation);
      } else {
        stopPolling();
        lastStatusUrl = statusUrl;
        setProcessingError(error?.message || '无法连接处理服务。', true);
      }
    } finally {
      clearTimeout(timeout);
      pollController = null;
    }
  }

  function startPolling(statusUrl) {
    stopPolling();
    const safeUrl = safeStatusUrl(statusUrl);
    if (!safeUrl) throw new Error('服务没有返回处理状态地址。');
    lastStatusUrl = safeUrl;
    pollFailures = 0;
    pollGeneration += 1;
    const generation = pollGeneration;
    schedulePoll(safeUrl, generation);
  }

  function statusPresentation(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'ready') return { label: '可使用', className: '' };
    if (value === 'failed') return { label: '失败', className: 'is-failed' };
    return { label: value === 'queued' ? '等待中' : '处理中', className: 'is-processing' };
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function renderRecentExams(exams) {
    recentList.replaceChildren();
    if (!exams.length) {
      recentList.append(createElement('p', 'recent-empty', '还没有导入记录。上传第一套 PDF 后，它会出现在这里。'));
      return;
    }
    exams
      .slice()
      .sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0))
      .slice(0, 6)
      .forEach((exam) => {
        const examId = String(exam?.examId || exam?.id || '').trim();
        const article = createElement('article', 'recent-card');
        const header = document.createElement('header');
        const title = createElement('h3', '', exam?.title || '未命名试卷');
        title.title = title.textContent;
        const presentation = statusPresentation(exam?.status);
        const badge = createElement('span', 'recent-status ' + presentation.className, presentation.label);
        header.append(title, badge);

        const meta = createElement('div', 'recent-meta');
        const progress = normalizeProgress(exam?.progress, exam?.status === 'ready' ? 100 : 0);
        if (exam?.status !== 'ready') meta.append(createElement('span', '', Math.round(progress) + '%'));
        if (exam?.hasAnswer) meta.append(createElement('span', '', '含答案'));
        if (exam?.hasAudio) meta.append(createElement('span', '', '含听力'));
        const reviews = reviewCountFrom(exam);
        if (reviews !== null) meta.append(createElement('span', '', reviews + ' 项待复核'));
        if (!meta.childElementCount) meta.append(createElement('span', '', exam?.stage || '完整试卷'));

        const footer = document.createElement('footer');
        const time = createElement('time', '', formatDate(exam?.createdAt || exam?.updatedAt));
        if (exam?.createdAt) time.dateTime = String(exam.createdAt);
        footer.append(time);
        if (exam?.status === 'ready' && examId) {
          const link = createElement('a', '', '打开试卷 →');
          link.href = 'reader.html?paper=' + encodeURIComponent(examId);
          footer.append(link);
        } else {
          footer.append(createElement('span', 'recent-stage', String(exam?.message || exam?.stage || '正在处理')));
        }
        article.append(header, meta, footer);
        recentList.append(article);
      });
  }

  async function loadRecentExams() {
    if (!recentList || !refreshButton) return;
    refreshButton.disabled = true;
    recentList.setAttribute('aria-busy', 'true');
    try {
      const data = await requestJson('/api/exams');
      const exams = Array.isArray(data) ? data : Array.isArray(data?.exams) ? data.exams : [];
      renderRecentExams(exams);
    } catch (error) {
      recentList.replaceChildren(createElement('p', 'recent-empty', '暂时无法读取导入记录：' + String(error?.message || '请稍后重试')));
    } finally {
      recentList.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }

  async function submitUpload(event) {
    event.preventDefault();
    if (!validateForm()) return;
    // FormData must be captured before setFormBusy disables the inputs.
    // Disabled controls are deliberately omitted by the browser otherwise.
    const uploadBody = new FormData(form);
    stopPolling();
    startProcessingView();
    clearFormError();
    setFormBusy(true);
    updateProcessing({
      status: 'uploading',
      stage: 'upload',
      progress: 3,
      message: '正在上传原卷和附件，请保持此页面打开。',
    });
    try {
      const data = await uploadFormData(uploadBody, (loaded, total, lengthComputable) => {
        const ratio = lengthComputable && total > 0 ? clamp(loaded / total, 0, 1) : null;
        const progress = ratio === null ? 3 : 3 + ratio * 6;
        const transferred = formatBytes(loaded);
        const expected = ratio === null ? '' : ' / ' + formatBytes(total);
        updateProcessing({
          status: 'uploading',
          stage: 'upload',
          progress,
          message: '正在上传原卷和附件：' + transferred + expected,
        });
      });
      activeExamId = String(data?.examId || '');
      updateProcessing({ ...data, progress: 9, message: '文件已保存，等待解析任务启动。' });
      if (String(data?.status || '').toLowerCase() === 'ready') {
        await completeProcessing(data);
        return;
      }
      startPolling(data?.statusUrl);
    } catch (error) {
      stopPolling();
      setProcessingError(error?.message || '上传失败，请确认服务已启动后重试。');
      showFormError(error?.message || '上传失败，请确认文件格式和服务状态。');
    }
  }

  $$('input[type="file"]', form).forEach((input) => {
    input.addEventListener('change', () => {
      updateFileField(input);
      if (input.id === 'exam-pdf') validateFile(input, pdfExtensions, '试卷 PDF', true);
      else if (input.id === 'answer-pdf') validateFile(input, pdfExtensions, '答案 PDF');
      else validateFile(input, audioExtensions, '听力音频');
    });
    updateFileField(input);
  });
  $('#exam-title')?.addEventListener('input', (event) => {
    if (event.currentTarget.value.trim()) setFieldError(event.currentTarget, '');
  });
  form?.addEventListener('submit', submitUpload);
  form?.addEventListener('reset', () => {
    window.setTimeout(() => {
      clearFormError();
      $$('input', form).forEach((input) => setFieldError(input, ''));
      $$('input[type="file"]', form).forEach(updateFileField);
    }, 0);
  });
  retryButton?.addEventListener('click', () => {
    if (!lastStatusUrl) return;
    $('#processing-error').hidden = true;
    processingDetail?.setAttribute('aria-busy', 'true');
    processingCard.dataset.state = 'processing';
    setFormBusy(true);
    startPolling(lastStatusUrl);
  });
  refreshButton?.addEventListener('click', loadRecentExams);
  addEventListener('beforeunload', stopPolling);

  loadRecentExams();
})();
