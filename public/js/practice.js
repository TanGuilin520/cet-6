(() => {
  'use strict';

  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const formatTime = (seconds) => {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  };

  const reader = $('#reader-page');
  const paperId = new URLSearchParams(location.search).get('paper') || 'original-reading-demo';
  const storageKey = `reading-lab:${paperId}`;
  const wordbookKey = 'reading-lab:wordbook';
  const defaultNotes = [
    { id: 'evidence', text: '文章的变化从“需求访谈”开始，首段可作为第 26 题的证据。', time: '刚刚', tone: 'blue' },
    { id: 'contribute', text: 'contribute 后面常接 to，表达“为某事作出贡献”。', time: '9 分钟前', tone: 'amber' },
  ];
  const correctAnswers = { q26: 'B', q27: 'C', q28: 'A' };
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  })();
  const storedWordbook = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(wordbookKey) || '[]');
      return Array.isArray(value) ? value : (Array.isArray(stored.words) ? stored.words : []);
    } catch { return Array.isArray(stored.words) ? stored.words : []; }
  })();
  const markTools = new Set(['select', 'pen', 'highlighter', 'eraser']);
  const tagTones = new Set(['amber', 'blue', 'green', 'purple']);
  const normalizeInkStrokes = (items) => {
    if (!Array.isArray(items)) return [];
    return items.slice(-200).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const tool = item.tool === 'highlighter' ? 'highlighter' : 'pen';
      const color = /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#315f89';
      const points = Array.isArray(item.points) ? item.points.slice(0, 5000).flatMap((point) => {
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
        return [{ x: clamp(x, 0, 1), y: clamp(y, 0, 1) }];
      }) : [];
      if (points.length < 2) return [];
      return [{
        id: String(item.id || `stroke-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        tool,
        color,
        size: clamp(Number(item.size) || (tool === 'highlighter' ? 16 : 2.6), 1, 28),
        points,
        createdAt: Number(item.createdAt) || Date.now(),
      }];
    });
  };
  const normalizeTextTags = (items) => {
    if (!Array.isArray(items)) return [];
    return items.slice(-120).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const start = Math.max(0, Math.floor(Number(item.start)));
      const end = Math.max(start + 1, Math.floor(Number(item.end)));
      const quote = String(item.quote || '').trim().slice(0, 500);
      const label = String(item.label || '').trim().slice(0, 16);
      if (!quote || !label) return [];
      return [{
        id: String(item.id || `tag-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        start,
        end,
        quote,
        label,
        note: String(item.note || '').trim().slice(0, 260),
        tone: tagTones.has(item.tone) ? item.tone : 'amber',
        createdAt: Number(item.createdAt) || Date.now(),
      }];
    });
  };
  const state = {
    fontScale: clamp(Number(stored.fontScale) || 1, 0.88, 1.28),
    translation: Boolean(stored.translation),
    focus: Boolean(stored.focus),
    bookmarked: Boolean(stored.bookmarked),
    markTool: markTools.has(stored.markTool) ? stored.markTool : 'select',
    inkColor: /^#[0-9a-f]{6}$/i.test(String(stored.inkColor || '')) ? stored.inkColor : '#315f89',
    inkStrokes: normalizeInkStrokes(stored.inkStrokes),
    textTags: normalizeTextTags(stored.textTags),
    markHistory: [],
    answers: stored.answers && typeof stored.answers === 'object' ? stored.answers : {},
    submitted: Boolean(stored.submitted),
    notes: Array.isArray(stored.notes) ? stored.notes : defaultNotes,
    words: storedWordbook,
    audioTime: clamp(Number(stored.audioTime) || 0, 0, 138),
    audioRate: clamp(Number(stored.audioRate) || 1, 0.75, 1.5),
    aiMessages: Array.isArray(stored.aiMessages)
      ? stored.aiMessages.slice(-20).flatMap((message) => {
        const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : '';
        const content = String(message?.content || '').trim().slice(0, 8000);
        return role && content ? [{ role, content }] : [];
      })
      : [],
    aiContext: String(stored.aiContext || '').trim().slice(0, 5500),
  };
  let activeDrawer = null;
  let activeWord = null;
  let toastTimer = 0;
  let audioTimer = 0;
  let audioPlaying = false;
  let readingUtterance = null;
  let activeTextTag = null;
  let pendingTextSelection = null;
  let chatContext = state.aiContext;
  let chatPending = false;

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...state, words: undefined }));
      localStorage.setItem(wordbookKey, JSON.stringify(state.words));
    } catch { /* storage is optional */ }
  }

  function showToast(message) {
    const toast = $('#reader-toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function updateRootState() {
    reader?.classList.toggle('is-showing-translation', state.translation);
    reader?.classList.toggle('is-annotation-mode', state.markTool !== 'select');
    reader?.classList.toggle('is-drawing-mode', ['pen', 'highlighter', 'eraser'].includes(state.markTool));
    reader?.classList.toggle('is-eraser-mode', state.markTool === 'eraser');
    reader?.classList.toggle('is-focus-mode', state.focus);
    reader?.style.setProperty('--reader-font-scale', state.fontScale.toFixed(2));
    const output = $('#font-size');
    if (output) output.textContent = `${Math.round(state.fontScale * 100)}%`;
    $('#toggle-translation')?.setAttribute('aria-pressed', String(state.translation));
    $('#focus-mode')?.setAttribute('aria-pressed', String(state.focus));
    if (reader) {
      reader.dataset.markTool = state.markTool;
    }
    $$('[data-mark-tool]').forEach((button) => {
      const selected = button.dataset.markTool === state.markTool;
      button.setAttribute('aria-pressed', String(selected));
    });
    const undoButton = $('#mark-undo');
    if (undoButton) {
      undoButton.disabled = state.markHistory.length === 0;
      undoButton.setAttribute('aria-disabled', String(state.markHistory.length === 0));
    }
    const inkColor = $('#ink-color');
    if (inkColor && inkColor.value !== state.inkColor) inkColor.value = state.inkColor;
    const bookmark = $('#bookmark-passage');
    if (bookmark) bookmark.setAttribute('aria-pressed', String(state.bookmarked));
  }

  // Toolbar --------------------------------------------------------------
  $('#font-smaller')?.addEventListener('click', () => {
    state.fontScale = clamp(Number((state.fontScale - 0.06).toFixed(2)), 0.88, 1.28);
    updateRootState(); scheduleMarkupRender(); save();
  });
  $('#font-larger')?.addEventListener('click', () => {
    state.fontScale = clamp(Number((state.fontScale + 0.06).toFixed(2)), 0.88, 1.28);
    updateRootState(); scheduleMarkupRender(); save();
  });
  $('#toggle-translation')?.addEventListener('click', () => {
    state.translation = !state.translation;
    updateRootState(); scheduleMarkupRender(); save();
    showToast(state.translation ? '已显示段落译文' : '已隐藏段落译文');
  });
  $$('[data-mark-tool]').forEach((button) => button.addEventListener('click', () => {
    const tool = button.dataset.markTool;
    if (!markTools.has(tool)) return;
    state.markTool = tool;
    closeWordPopover();
    closeAnnotationEditor();
    updateRootState(); save();
    const hints = {
      select: '选择工具：拖选一段文字，然后记录标签',
      pen: '画笔已开启：按住并连续拖动书写',
      highlighter: '荧光笔已开启：按住并连续拖动标记',
      eraser: '橡皮擦已开启：按住并划过笔迹进行擦除',
    };
    showToast(hints[tool]);
  }));
  $('#ink-color')?.addEventListener('input', (event) => {
    state.inkColor = event.currentTarget.value;
    save();
  });
  $('#focus-mode')?.addEventListener('click', () => {
    state.focus = !state.focus;
    updateRootState(); save();
    showToast(state.focus ? '已进入专注阅读模式' : '已退出专注阅读模式');
  });
  $('#bookmark-passage')?.addEventListener('click', () => {
    state.bookmarked = !state.bookmarked;
    updateRootState(); save();
    showToast(state.bookmarked ? '本文已收藏' : '已取消收藏');
  });
  $('#reader-menu-toggle')?.addEventListener('click', (event) => {
    const open = !reader.classList.contains('index-open');
    reader.classList.toggle('index-open', open);
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $('[data-close-index]')?.addEventListener('click', () => {
    reader.classList.remove('index-open');
    $('#reader-menu-toggle')?.setAttribute('aria-expanded', 'false');
  });

  // Drawers --------------------------------------------------------------
  const scrim = $('#drawer-scrim');
  function closeDrawer() {
    if (activeDrawer) {
      activeDrawer.classList.remove('is-open');
      activeDrawer.setAttribute('aria-hidden', 'true');
      activeDrawer = null;
    }
    if (scrim) {
      scrim.classList.remove('is-open');
      scrim.hidden = true;
    }
    document.body.classList.remove('reader-drawer-open');
  }
  function openDrawer(name) {
    const drawer = $(`#${name}`);
    if (!drawer) return;
    closeDrawer();
    activeDrawer = drawer;
    if (scrim) {
      scrim.hidden = false;
      requestAnimationFrame(() => scrim.classList.add('is-open'));
    }
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('reader-drawer-open');
    window.setTimeout(() => drawer.querySelector('textarea, button, [tabindex]')?.focus(), 100);
  }
  document.addEventListener('click', (event) => {
    const drawerTrigger = event.target.closest('[data-drawer-target]');
    if (drawerTrigger) openDrawer(drawerTrigger.dataset.drawerTarget);
    if (event.target.closest('[data-close-drawer], .drawer-close')) closeDrawer();
  });
  scrim?.addEventListener('click', closeDrawer);

  // Notes ---------------------------------------------------------------
  const noteEditor = $('#note-editor');
  const noteList = $('#notes-list');
  const noteCount = $('#note-count');
  function noteEscape(text) {
    return String(text).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }
  function renderNotes() {
    if (!noteList) return;
    noteList.innerHTML = state.notes.map((note) => `
      <article class="note-item" data-note-id="${note.id}">
        <header><span class="note-dot note-dot--${note.tone || 'blue'}"></span><time>${noteEscape(note.time || '刚刚')}</time><button type="button" data-delete-note aria-label="删除笔记">×</button></header>
        <p>${noteEscape(note.text).replace(/\b(flexible|visible|contribute)\b/gi, '<b>$1</b>')}</p>
      </article>`).join('');
    if (noteCount) noteCount.textContent = String(state.notes.length);
  }
  function updateCharCount() {
    const node = $('#note-char-count');
    if (node) node.textContent = String(noteEditor?.value.length || 0);
  }
  noteEditor?.addEventListener('input', updateCharCount);
  $('#save-note')?.addEventListener('click', () => {
    const text = noteEditor?.value.trim();
    if (!text) { showToast('先写下一条笔记再保存'); return; }
    state.notes.unshift({ id: `note-${Date.now()}`, text, time: '刚刚', tone: state.notes.length % 2 ? 'blue' : 'amber' });
    noteEditor.value = '';
    updateCharCount(); renderNotes(); save();
    showToast('笔记已保存');
  });
  noteList?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-delete-note]')?.closest('.note-item');
    if (!item) return;
    state.notes = state.notes.filter((note) => note.id !== item.dataset.noteId);
    renderNotes(); save(); showToast('笔记已删除');
  });

  // Answers -------------------------------------------------------------
  function updateAnswers() {
    const answered = Object.keys(correctAnswers).filter((question) => state.answers[question]).length;
    const status = $('#question-status');
    if (status) status.textContent = `已作答 ${answered} / 3`;
    $$('.question-card').forEach((card) => {
      const input = $(`input[name="q${card.dataset.question}"]:checked`, card);
      card.classList.toggle('is-answered', Boolean(input));
    });
  }
  function restoreAnswers() {
    Object.entries(state.answers).forEach(([name, value]) => {
      const input = $(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    });
    updateAnswers();
    if (state.submitted) evaluateAnswers(false);
  }
  function evaluateAnswers(openAfter = true) {
    const correct = Object.entries(correctAnswers).filter(([name, answer]) => state.answers[name] === answer).length;
    const answered = Object.keys(correctAnswers).filter((name) => state.answers[name]).length;
    $$('.question-card').forEach((card) => {
      const name = `q${card.dataset.question}`;
      $$('label.choice', card).forEach((label) => {
        const input = $('input', label);
        label.classList.remove('is-correct', 'is-wrong');
        if (input.value === correctAnswers[name]) label.classList.add('is-correct');
        if (input.checked && input.value !== correctAnswers[name]) label.classList.add('is-wrong');
      });
    });
    const summary = $('#answer-summary');
    if (summary) {
      summary.innerHTML = `<span class="summary-ring">${correct}/${Object.keys(correctAnswers).length}</span><div><b>${answered === 3 ? `本次答对 ${correct} 题` : `已完成 ${answered} 道作答`}</b><p>${correct === 3 ? '很好，所有题目都定位正确。' : '查看每一道题的定位说明，复盘题干和证据。'}</p></div>`;
    }
    $$('.answer-item').forEach((item) => {
      const answer = correctAnswers[`q${item.dataset.answer}`];
      const selected = state.answers[`q${item.dataset.answer}`];
      item.classList.toggle('is-correct', selected === answer);
      item.classList.toggle('is-wrong', Boolean(selected) && selected !== answer);
    });
    state.submitted = true;
    save();
    if (openAfter) {
      openDrawer('answer-drawer');
      showToast(`已提交：答对 ${correct} / 3 题`);
    }
  }
  $('#question-list')?.addEventListener('change', (event) => {
    const input = event.target.closest('input[type="radio"]');
    if (!input) return;
    state.answers[input.name] = input.value;
    state.submitted = false;
    updateAnswers(); save();
  });
  $('#submit-answers')?.addEventListener('click', () => {
    const answered = Object.keys(correctAnswers).filter((name) => state.answers[name]).length;
    if (answered < 3) { showToast(`还差 ${3 - answered} 题，完成后再提交`); return; }
    evaluateAnswers();
  });
  $('#clear-answers')?.addEventListener('click', () => {
    state.answers = {}; state.submitted = false;
    $$('input[type="radio"]', $('#question-list')).forEach((input) => { input.checked = false; });
    $$('label.choice').forEach((label) => label.classList.remove('is-correct', 'is-wrong'));
    updateAnswers(); save(); showToast('本篇作答已清空');
  });

  // Audio ---------------------------------------------------------------
  const audioDuration = 138;
  const audioBar = $('#audio-player');
  const audioProgress = $('#audio-progress');
  const audioCurrent = $('#audio-current-time');
  const audioRate = $('#audio-rate');
  const audioText = $('.passage')?.innerText || '';
  function updateAudioUI() {
    const percent = (state.audioTime / audioDuration) * 100;
    if (audioProgress) {
      audioProgress.value = String(Math.round(state.audioTime));
      audioProgress.style.setProperty('--range-progress', `${percent}%`);
    }
    if (audioCurrent) audioCurrent.textContent = formatTime(state.audioTime);
    audioBar?.classList.toggle('is-playing', audioPlaying);
    $('#audio-play')?.setAttribute('aria-pressed', String(audioPlaying));
    $('#audio-play')?.setAttribute('aria-label', audioPlaying ? '暂停文章音频' : '播放文章音频');
  }
  function stopAudioTimer() {
    clearInterval(audioTimer); audioTimer = 0;
  }
  function stopSpeech() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    readingUtterance = null;
  }
  function beginSpeech() {
    if (!('speechSynthesis' in window) || !audioText) return;
    stopSpeech();
    readingUtterance = new SpeechSynthesisUtterance(audioText.replace(/\s+/g, ' '));
    readingUtterance.lang = 'en-GB';
    readingUtterance.rate = state.audioRate;
    readingUtterance.onend = () => { if (audioPlaying) pauseAudio(true); };
    window.speechSynthesis.speak(readingUtterance);
  }
  function pauseAudio(finished = false) {
    audioPlaying = false; stopAudioTimer();
    if (!finished && 'speechSynthesis' in window) window.speechSynthesis.pause();
    if (finished) { state.audioTime = audioDuration; stopSpeech(); }
    updateAudioUI(); save();
  }
  function playAudio() {
    if (state.audioTime >= audioDuration) state.audioTime = 0;
    audioPlaying = true;
    stopAudioTimer();
    if ('speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume();
    else beginSpeech();
    const tick = () => {
      state.audioTime = clamp(state.audioTime + state.audioRate, 0, audioDuration);
      if (state.audioTime >= audioDuration) pauseAudio(true);
      else updateAudioUI();
    };
    audioTimer = setInterval(tick, 1000);
    updateAudioUI();
  }
  $('#audio-play')?.addEventListener('click', () => (audioPlaying ? pauseAudio() : playAudio()));
  audioProgress?.addEventListener('input', (event) => {
    state.audioTime = clamp(Number(event.target.value), 0, audioDuration);
    updateAudioUI(); save();
  });
  $$('[data-seconds]').forEach((button) => button.addEventListener('click', () => {
    state.audioTime = clamp(state.audioTime + Number(button.dataset.seconds || 0), 0, audioDuration);
    updateAudioUI(); save();
  }));
  audioRate?.addEventListener('change', () => {
    state.audioRate = Number(audioRate.value) || 1;
    if (audioPlaying) beginSpeech();
    save(); showToast(`播放速度已设为 ${state.audioRate}×`);
  });

  // Word lookup and pronunciation (shared module) -----------------------
  const wordLookup = typeof WordLookup !== 'undefined' ? WordLookup.create({
    onOpen: ({ word }) => {
      activeWord = { word, translation: '', phonetic: '' };
      syncWordSaveState();
    },
    onClose: () => { activeWord = null; },
  }) : null;

  function syncWordSaveState() {
    if (!wordLookup || !activeWord) return;
    const saved = state.words.some((item) => item.word.toLowerCase() === activeWord.word.toLowerCase());
    $('[data-wl-save]', wordLookup.element)?.setAttribute('aria-pressed', String(saved));
  }

  function toggleSavedWord(button) {
    if (!activeWord) return;
    const card = wordLookup?.element;
    const translation = $('.wl-translation', card)?.textContent.trim();
    const phonetic = $('.wl-ipa', card)?.textContent.trim() || '';
    const index = state.words.findIndex((item) => item.word.toLowerCase() === activeWord.word.toLowerCase());
    if (index >= 0) {
      state.words.splice(index, 1);
      button.setAttribute('aria-pressed', 'false');
      showToast('已从生词本移除');
    } else {
      state.words.unshift({
        word: activeWord.word,
        translation: translation && !translation.startsWith('正在') && !translation.includes('暂时不可用') ? translation : '待补充释义',
        phonetic,
        savedAt: Date.now(),
      });
      button.setAttribute('aria-pressed', 'true');
      showToast('已加入生词本，跨试卷保留');
    }
    updateWordBank();
    save();
  }

  function openWordPopover(target) {
    if (!wordLookup) return;
    const word = target.dataset.word || target.textContent.trim();
    wordLookup.open(target, word);
  }

  if (wordLookup) {
    const noteButton = document.createElement('button');
    noteButton.type = 'button';
    noteButton.className = 'text-action';
    noteButton.textContent = '记入笔记';
    noteButton.setAttribute('aria-label', '把当前单词记入笔记');
    noteButton.addEventListener('click', () => {
      const card = wordLookup.element;
      const word = activeWord?.word || wordLookup.currentWord;
      if (!word || !noteEditor) return;
      const translation = $('.wl-translation', card)?.textContent.trim() || '';
      noteEditor.value = `${word} — ${translation}`.replace(/\s+$/, '');
      updateCharCount();
      wordLookup.close();
      openDrawer('note-drawer');
      setTimeout(() => noteEditor.focus(), 120);
    });
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'word-save';
    saveButton.dataset.wlSave = '';
    saveButton.setAttribute('aria-pressed', 'false');
    saveButton.setAttribute('aria-label', '加入或移出生词本');
    saveButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v15a1 1 0 0 1-1.5.86L12 17l-6.5 3.86A1 1 0 0 1 4 20V5a2 2 0 0 1 2-2Z" /></svg>生词本';
    saveButton.addEventListener('click', () => toggleSavedWord(saveButton));
    wordLookup.actionsSlot.append(noteButton, saveButton);
  }

  function makePassageWordsClickable() {
    const passage = $('.passage');
    if (!passage) return;
    const walker = document.createTreeWalker(passage, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('.word-token, .translation-line, button, script, style')) return NodeFilter.FILTER_REJECT;
        return /[A-Za-z]{2,}/.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      const text = node.nodeValue;
      const fragment = document.createDocumentFragment();
      const expression = /([A-Za-z]+(?:['-][A-Za-z]+)*)/g;
      let start = 0;
      let match;
      while ((match = expression.exec(text))) {
        if (match.index > start) fragment.append(document.createTextNode(text.slice(start, match.index)));
        const token = document.createElement('span');
        token.className = 'auto-word-token';
        token.dataset.word = match[1];
        token.title = `点击查询 ${match[1]}`;
        token.textContent = match[1];
        fragment.append(token);
        start = match.index + match[0].length;
      }
      if (start < text.length) fragment.append(document.createTextNode(text.slice(start)));
      node.replaceWith(fragment);
    });
  }

  const annotationEditor = $('#annotation-editor');
  const annotationInput = $('#annotation-input');
  const annotationLabel = $('#annotation-label');
  const annotationDelete = $('#annotation-delete');
  const paperSheet = $('#paper-sheet');
  const passage = $('.passage');
  let activeTagTone = 'amber';
  let markupRenderFrame = 0;
  let drawingPointerId = null;
  let activeStroke = null;
  let activeStrokePath = null;
  let erasedStrokes = [];

  const cloneStroke = (stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) });
  const cloneTag = (tag) => ({ ...tag });
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const inkLayer = paperSheet ? document.createElementNS(svgNamespace, 'svg') : null;
  const textTagLayer = paperSheet ? document.createElement('div') : null;
  if (inkLayer && textTagLayer) {
    inkLayer.classList.add('ink-layer');
    inkLayer.setAttribute('aria-hidden', 'true');
    textTagLayer.className = 'text-tag-layer';
    textTagLayer.setAttribute('aria-label', '已保存的文本标签');
    paperSheet.append(textTagLayer, inkLayer);
  }

  function pushMarkHistory(action) {
    state.markHistory.push(action);
    state.markHistory = state.markHistory.slice(-50);
    updateRootState();
  }

  function smoothPath(points, width, height) {
    const scaled = points.map((point) => ({ x: point.x * width, y: point.y * height }));
    if (!scaled.length) return '';
    if (scaled.length === 1) return `M ${scaled[0].x.toFixed(1)} ${scaled[0].y.toFixed(1)} l .1 .1`;
    let path = `M ${scaled[0].x.toFixed(1)} ${scaled[0].y.toFixed(1)}`;
    for (let index = 1; index < scaled.length - 1; index += 1) {
      const point = scaled[index];
      const next = scaled[index + 1];
      const middleX = (point.x + next.x) / 2;
      const middleY = (point.y + next.y) / 2;
      path += ` Q ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${middleX.toFixed(1)} ${middleY.toFixed(1)}`;
    }
    const last = scaled[scaled.length - 1];
    path += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
    return path;
  }

  function createStrokePath(stroke, width, height) {
    const path = document.createElementNS(svgNamespace, 'path');
    path.dataset.strokeId = stroke.id;
    path.setAttribute('d', smoothPath(stroke.points, width, height));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke.color);
    path.setAttribute('stroke-width', String(stroke.size));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('opacity', stroke.tool === 'highlighter' ? '.32' : '.92');
    return path;
  }

  function renderInkStrokes() {
    if (!inkLayer || !paperSheet) return;
    const width = paperSheet.clientWidth;
    const height = paperSheet.clientHeight;
    inkLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    inkLayer.replaceChildren(...state.inkStrokes.map((stroke) => createStrokePath(stroke, width, height)));
  }

  function textOffsetAt(container, offset) {
    if (!passage) return 0;
    const before = document.createRange();
    before.selectNodeContents(passage);
    try { before.setEnd(container, offset); } catch { return 0; }
    return before.toString().length;
  }

  function rangeFromOffsets(start, end) {
    if (!passage) return null;
    const range = document.createRange();
    const walker = document.createTreeWalker(passage, NodeFilter.SHOW_TEXT);
    let position = 0;
    let startSet = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nextPosition = position + node.nodeValue.length;
      if (!startSet && start <= nextPosition) {
        range.setStart(node, clamp(start - position, 0, node.nodeValue.length));
        startSet = true;
      }
      if (startSet && end <= nextPosition) {
        range.setEnd(node, clamp(end - position, 0, node.nodeValue.length));
        return range;
      }
      position = nextPosition;
    }
    return null;
  }

  function validTagRange(tag) {
    let range = rangeFromOffsets(tag.start, tag.end);
    if (range && range.toString().trim() === tag.quote) return range;
    const fullText = passage?.textContent || '';
    const foundAt = fullText.indexOf(tag.quote);
    if (foundAt < 0) return null;
    tag.start = foundAt;
    tag.end = foundAt + tag.quote.length;
    range = rangeFromOffsets(tag.start, tag.end);
    return range;
  }

  function renderTextTags() {
    if (!textTagLayer || !paperSheet) return;
    textTagLayer.replaceChildren();
    const sheetBox = paperSheet.getBoundingClientRect();
    state.textTags.forEach((tag) => {
      const range = validTagRange(tag);
      if (!range) return;
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      rects.forEach((rect) => {
        const highlight = document.createElement('span');
        highlight.className = `text-tag-highlight text-tag-highlight--${tag.tone}`;
        Object.assign(highlight.style, {
          left: `${rect.left - sheetBox.left}px`,
          top: `${rect.top - sheetBox.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        textTagLayer.append(highlight);
      });
      const lastRect = rects[rects.length - 1];
      if (!lastRect) return;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = `text-tag-badge text-tag-badge--${tag.tone}`;
      badge.dataset.textTagId = tag.id;
      badge.textContent = tag.label;
      badge.title = tag.note ? `${tag.label}：${tag.note}` : `编辑标签：${tag.label}`;
      badge.setAttribute('aria-label', `${tag.label}，${tag.quote}${tag.note ? `，备注：${tag.note}` : ''}`);
      Object.assign(badge.style, {
        left: `${clamp(lastRect.right - sheetBox.left + 5, 5, Math.max(5, sheetBox.width - 96))}px`,
        top: `${lastRect.top - sheetBox.top - 7}px`,
      });
      textTagLayer.append(badge);
    });
    renderTextTagSummary();
  }

  function renderTextTagSummary() {
    const list = $('#side-text-tag-list');
    const count = $('#text-tag-count');
    if (count) count.textContent = String(state.textTags.length);
    if (!list) return;
    list.replaceChildren();
    if (!state.textTags.length) {
      const empty = document.createElement('li');
      empty.className = 'side-text-tag-empty';
      empty.textContent = '拖选一段文字后添加标签';
      list.append(empty);
      return;
    }
    state.textTags.slice(-5).reverse().forEach((tag) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const label = document.createElement('b');
      const quote = document.createElement('span');
      button.type = 'button';
      button.dataset.sideTextTagId = tag.id;
      button.title = `定位并编辑：${tag.quote}`;
      label.className = `side-text-tag-label side-text-tag-label--${tag.tone}`;
      label.textContent = tag.label;
      quote.textContent = tag.quote;
      button.append(label, quote);
      item.append(button);
      list.append(item);
    });
  }

  function scheduleMarkupRender() {
    cancelAnimationFrame(markupRenderFrame);
    markupRenderFrame = requestAnimationFrame(() => {
      renderInkStrokes();
      renderTextTags();
    });
  }

  function localInkPoint(event) {
    const box = paperSheet.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    };
  }

  function addStrokePoints(event) {
    if (!activeStroke || !paperSheet) return;
    const box = paperSheet.getBoundingClientRect();
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    events.forEach((pointerEvent) => {
      const point = localInkPoint(pointerEvent);
      const previous = activeStroke.points[activeStroke.points.length - 1];
      const distance = previous ? Math.hypot((point.x - previous.x) * box.width, (point.y - previous.y) * box.height) : Infinity;
      if (distance >= 1.4) activeStroke.points.push(point);
    });
    if (activeStrokePath) activeStrokePath.setAttribute('d', smoothPath(activeStroke.points, box.width, box.height));
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
    const amount = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
  }

  function eraseAt(event) {
    if (!paperSheet) return;
    const box = paperSheet.getBoundingClientRect();
    const point = { x: event.clientX - box.left, y: event.clientY - box.top };
    const removed = [];
    state.inkStrokes = state.inkStrokes.filter((stroke) => {
      const radius = 10 + stroke.size / 2;
      for (let index = 1; index < stroke.points.length; index += 1) {
        const start = { x: stroke.points[index - 1].x * box.width, y: stroke.points[index - 1].y * box.height };
        const end = { x: stroke.points[index].x * box.width, y: stroke.points[index].y * box.height };
        if (distanceToSegment(point, start, end) <= radius) {
          removed.push(stroke);
          return false;
        }
      }
      return true;
    });
    if (removed.length) {
      erasedStrokes.push(...removed.map(cloneStroke));
      renderInkStrokes();
    }
  }

  function finishDrawing(event) {
    if (drawingPointerId === null || event.pointerId !== drawingPointerId) return;
    if (state.markTool === 'eraser') {
      if (erasedStrokes.length) {
        pushMarkHistory({ kind: 'remove-strokes', items: erasedStrokes.map(cloneStroke), label: '擦除笔迹' });
        showToast(`已擦除 ${erasedStrokes.length} 条笔迹`);
      }
    } else if (activeStroke) {
      addStrokePoints(event);
      if (activeStroke.points.length === 1) {
        const point = activeStroke.points[0];
        activeStroke.points.push({ x: point.x + 0.0001, y: point.y + 0.0001 });
      }
      state.inkStrokes.push(activeStroke);
      state.inkStrokes = state.inkStrokes.slice(-200);
      pushMarkHistory({ kind: 'add-stroke', items: [cloneStroke(activeStroke)], label: activeStroke.tool === 'highlighter' ? '荧光标记' : '手写笔迹' });
      showToast(activeStroke.tool === 'highlighter' ? '荧光标记已保存' : '笔迹已保存');
    }
    try { inkLayer.releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be gone */ }
    drawingPointerId = null;
    activeStroke = null;
    activeStrokePath = null;
    erasedStrokes = [];
    renderInkStrokes();
    save();
  }

  inkLayer?.addEventListener('pointerdown', (event) => {
    if (!['pen', 'highlighter', 'eraser'].includes(state.markTool)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    drawingPointerId = event.pointerId;
    erasedStrokes = [];
    inkLayer.setPointerCapture(event.pointerId);
    if (state.markTool === 'eraser') {
      eraseAt(event);
      return;
    }
    activeStroke = {
      id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool: state.markTool,
      color: state.markTool === 'highlighter' ? '#f1c84c' : state.inkColor,
      size: state.markTool === 'highlighter' ? 17 : 2.7,
      points: [localInkPoint(event)],
      createdAt: Date.now(),
    };
    activeStrokePath = createStrokePath(activeStroke, paperSheet.clientWidth, paperSheet.clientHeight);
    inkLayer.append(activeStrokePath);
  });
  inkLayer?.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drawingPointerId) return;
    event.preventDefault();
    if (state.markTool === 'eraser') eraseAt(event);
    else addStrokePoints(event);
  });
  inkLayer?.addEventListener('pointerup', finishDrawing);
  inkLayer?.addEventListener('pointercancel', finishDrawing);

  function setActiveTagPreset(label, tone) {
    activeTagTone = tagTones.has(tone) ? tone : 'amber';
    if (annotationLabel) annotationLabel.value = label;
    $$('[data-tag-label]').forEach((button) => {
      const checked = button.dataset.tagLabel === label && button.dataset.tagTone === activeTagTone;
      button.setAttribute('aria-checked', String(checked));
    });
  }

  function positionAnnotationEditor() {
    if (!annotationEditor?.classList.contains('is-visible')) return;
    const source = activeTextTag || pendingTextSelection;
    const range = source ? rangeFromOffsets(source.start, source.end) : null;
    const box = range?.getBoundingClientRect();
    if (!box) return;
    const width = annotationEditor.offsetWidth;
    const height = annotationEditor.offsetHeight;
    const left = clamp(box.left + box.width / 2 - width / 2, 12, Math.max(12, innerWidth - width - 12));
    const preferredTop = box.bottom + height + 12 > innerHeight ? box.top - height - 12 : box.bottom + 12;
    const top = clamp(preferredTop, 12, Math.max(12, innerHeight - height - 12));
    Object.assign(annotationEditor.style, { left: `${left}px`, top: `${top}px` });
  }

  function openAnnotationEditor(selection, existing = null) {
    if (!annotationEditor || !annotationInput || !annotationLabel) return;
    activeTextTag = existing;
    pendingTextSelection = selection;
    const target = $('#annotation-editor-target');
    if (target) target.textContent = `“${selection.quote}”`;
    setActiveTagPreset(existing?.label || '重点', existing?.tone || 'amber');
    annotationInput.value = existing?.note || '';
    if (annotationDelete) annotationDelete.hidden = !existing;
    annotationEditor.classList.add('is-visible');
    annotationEditor.setAttribute('aria-hidden', 'false');
    closeWordPopover();
    requestAnimationFrame(() => {
      positionAnnotationEditor();
      annotationLabel.focus();
      annotationLabel.select();
    });
  }

  function closeAnnotationEditor(clearSelection = true) {
    annotationEditor?.classList.remove('is-visible');
    annotationEditor?.setAttribute('aria-hidden', 'true');
    activeTextTag = null;
    pendingTextSelection = null;
    if (clearSelection) window.getSelection()?.removeAllRanges();
  }

  function captureTextSelection() {
    if (state.markTool !== 'select' || !passage || annotationEditor?.contains(document.activeElement)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!passage.contains(selection.anchorNode) || !passage.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const rawQuote = range.toString();
    const quote = rawQuote.trim();
    if (quote.length < 2) return;
    if (quote.length > 500) {
      showToast('一次最多记录 500 个字符，请缩小选择范围');
      return;
    }
    const leading = rawQuote.length - rawQuote.trimStart().length;
    const trailing = rawQuote.length - rawQuote.trimEnd().length;
    const start = textOffsetAt(range.startContainer, range.startOffset) + leading;
    const end = textOffsetAt(range.endContainer, range.endOffset) - trailing;
    openAnnotationEditor({ start, end, quote });
  }

  function saveTextTag() {
    if (!pendingTextSelection || !annotationLabel) return;
    const label = annotationLabel.value.trim();
    if (!label) {
      showToast('请填写标签名称');
      annotationLabel.focus();
      return;
    }
    const next = {
      ...pendingTextSelection,
      id: activeTextTag?.id || `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: label.slice(0, 16),
      note: annotationInput?.value.trim().slice(0, 260) || '',
      tone: activeTagTone,
      createdAt: activeTextTag?.createdAt || Date.now(),
    };
    if (activeTextTag) {
      const before = cloneTag(activeTextTag);
      state.textTags = state.textTags.map((tag) => tag.id === next.id ? next : tag);
      pushMarkHistory({ kind: 'replace-tag', before, after: cloneTag(next), label: '修改文本标签' });
    } else {
      state.textTags.push(next);
      pushMarkHistory({ kind: 'add-tag', items: [cloneTag(next)], label: '添加文本标签' });
    }
    closeAnnotationEditor();
    renderTextTags();
    save();
    showToast(`已保存标签：${next.label}`);
  }

  function deleteTextTag() {
    if (!activeTextTag) return;
    const removed = cloneTag(activeTextTag);
    state.textTags = state.textTags.filter((tag) => tag.id !== removed.id);
    pushMarkHistory({ kind: 'remove-tags', items: [removed], label: '删除文本标签' });
    closeAnnotationEditor();
    renderTextTags();
    save();
    showToast('文本标签已删除');
  }

  function undoAnnotation() {
    const action = state.markHistory.pop();
    if (!action) {
      showToast('没有可撤回的标注操作');
      updateRootState();
      return;
    }
    if (action.kind === 'add-stroke') {
      const ids = new Set(action.items.map((item) => item.id));
      state.inkStrokes = state.inkStrokes.filter((stroke) => !ids.has(stroke.id));
    } else if (action.kind === 'remove-strokes') {
      state.inkStrokes.push(...action.items.map(cloneStroke));
    } else if (action.kind === 'add-tag') {
      const ids = new Set(action.items.map((item) => item.id));
      state.textTags = state.textTags.filter((tag) => !ids.has(tag.id));
    } else if (action.kind === 'remove-tags') {
      state.textTags.push(...action.items.map(cloneTag));
    } else if (action.kind === 'replace-tag') {
      state.textTags = state.textTags.map((tag) => tag.id === action.before.id ? cloneTag(action.before) : tag);
    }
    closeAnnotationEditor();
    scheduleMarkupRender();
    save();
    updateRootState();
    showToast(`已撤回：${action.label}`);
  }

  passage?.addEventListener('pointerup', () => setTimeout(captureTextSelection, 0));
  function openStoredTextTag(tag) {
    const range = validTagRange(tag);
    if (!range) return;
    state.markTool = 'select';
    updateRootState();
    range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => openAnnotationEditor({ start: tag.start, end: tag.end, quote: tag.quote }, tag), 180);
  }
  textTagLayer?.addEventListener('click', (event) => {
    const badge = event.target.closest('[data-text-tag-id]');
    if (!badge) return;
    const tag = state.textTags.find((item) => item.id === badge.dataset.textTagId);
    if (!tag) return;
    openStoredTextTag(tag);
  });
  $('#side-text-tag-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-side-text-tag-id]');
    const tag = button && state.textTags.find((item) => item.id === button.dataset.sideTextTagId);
    if (tag) openStoredTextTag(tag);
  });
  $$('[data-tag-label]').forEach((button) => button.addEventListener('click', () => {
    setActiveTagPreset(button.dataset.tagLabel, button.dataset.tagTone);
  }));
  annotationLabel?.addEventListener('input', () => {
    $$('[data-tag-label]').forEach((button) => button.setAttribute('aria-checked', 'false'));
  });
  $('#annotation-save')?.addEventListener('click', saveTextTag);
  $('#annotation-cancel')?.addEventListener('click', () => closeAnnotationEditor());
  annotationDelete?.addEventListener('click', deleteTextTag);
  $('#mark-undo')?.addEventListener('click', undoAnnotation);
  annotationInput?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveTextTag();
    }
  });
  if ('ResizeObserver' in window && paperSheet) new ResizeObserver(scheduleMarkupRender).observe(paperSheet);
  addEventListener('resize', () => { scheduleMarkupRender(); positionAnnotationEditor(); });
  addEventListener('scroll', positionAnnotationEditor, true);

  function renderWordbookList(list, target) {
    if (!target) return;
    if (!list.length) {
      target.innerHTML = '<li class="wordbook-empty">还没有保存的生词。点击单词后，在释义卡片中选择“生词本”。</li>';
      return;
    }
    target.innerHTML = list.map((item) => {
      const word = noteEscape(item.word);
      const translation = noteEscape(item.translation || '待补充释义');
      return `<li data-word-item="${word}"><div><b>${word}</b><span>${translation}</span></div><button type="button" data-remove-word="${word}" aria-label="移除 ${word}">×</button></li>`;
    }).join('');
  }
  function updateWordBank() {
    const bank = $('#word-bank-list');
    if (!bank) return;
    const curated = [
      { word: 'flexible', translation: '灵活的' },
      { word: 'visible', translation: '可见的' },
      { word: 'contribute', translation: '贡献' },
    ];
    const combined = [...state.words, ...curated].filter((item, index, list) => list.findIndex((other) => other.word.toLowerCase() === item.word.toLowerCase()) === index).slice(0, 5);
    bank.innerHTML = combined.map((item) => `<li><b>${noteEscape(item.word)}</b><span>${noteEscape(item.translation || '待补充释义')}</span></li>`).join('');
    const count = $('#wordbook-count');
    if (count) count.textContent = String(state.words.length);
    renderWordbookList(state.words, $('#wordbook-list'));
  }
  function removeWord(word) {
    const before = state.words.length;
    state.words = state.words.filter((item) => item.word.toLowerCase() !== String(word).toLowerCase());
    if (state.words.length !== before) {
      updateWordBank(); save(); showToast(`已从生词本移除 ${word}`);
      if (activeWord?.word.toLowerCase() === String(word).toLowerCase()) wordLookup?.actionsSlot.querySelector('[data-wl-save]')?.setAttribute('aria-pressed', 'false');
    }
  }
  function closeWordPopover() {
    wordLookup?.close();
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-text-tag-id]')) return;
    const token = event.target.closest('.word-token, .auto-word-token');
    if (token) {
      if (state.markTool !== 'select' || window.getSelection()?.toString().trim()) return;
      event.preventDefault();
      openWordPopover(token);
      return;
    }
    const removeButton = event.target.closest('[data-remove-word]');
    if (removeButton) { removeWord(removeButton.dataset.removeWord); return; }
    if (
      annotationEditor?.classList.contains('is-visible')
      && !annotationEditor.contains(event.target)
      && !event.target.closest('[data-mark-tool]')
    ) closeAnnotationEditor();
  });
  $('#open-word-bank')?.addEventListener('click', () => { closeWordPopover(); updateWordBank(); openDrawer('wordbook-drawer'); });
  $('#clear-wordbook')?.addEventListener('click', () => {
    if (!state.words.length) { showToast('生词本已经是空的'); return; }
    state.words = []; updateWordBank(); save(); showToast('生词本已清空');
  });

  // DeepSeek study assistant -------------------------------------------
  const aiChatMessages = $('#ai-chat-messages');
  const aiChatForm = $('#ai-chat-form');
  const aiChatInput = $('#ai-chat-input');
  const aiChatSend = $('#ai-chat-send');
  const aiChatStatus = $('#ai-chat-status');
  const aiContextButton = $('#ai-chat-use-selection');

  function setAiChatStatus(message, tone = '') {
    if (!aiChatStatus) return;
    aiChatStatus.textContent = message;
    aiChatStatus.dataset.tone = tone;
    aiChatStatus.classList.toggle('is-error', tone === 'error');
    aiChatStatus.classList.toggle('is-loading', tone === 'loading');
    aiChatStatus.classList.toggle('is-success', tone === 'success');
  }

  function createAiMessage(role, content, extraClass = '') {
    const article = document.createElement('article');
    article.className = `ai-message ai-message--${role}${extraClass ? ` ${extraClass}` : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'ai-message-avatar';
    avatar.textContent = role === 'assistant' ? 'AI' : '我';
    const paragraph = document.createElement('p');
    paragraph.textContent = content;
    article.append(avatar, paragraph);
    return article;
  }

  function renderAiChat(showThinking = false) {
    if (!aiChatMessages) return;
    aiChatMessages.replaceChildren();
    if (!state.aiMessages.length) {
      aiChatMessages.append(createAiMessage('assistant', '你好！可以问我这篇文章的主旨、词义、选项证据或四级阅读方法。'));
    } else {
      state.aiMessages.forEach((message) => aiChatMessages.append(createAiMessage(message.role, message.content)));
    }
    if (showThinking) aiChatMessages.append(createAiMessage('assistant', '正在阅读并整理答案…', 'is-pending'));
    requestAnimationFrame(() => { aiChatMessages.scrollTop = aiChatMessages.scrollHeight; });
  }

  function getPassageContext() {
    const passage = $('.passage');
    if (!passage) return '';
    const clone = passage.cloneNode(true);
    $$('.translation-line, .bookmark-button, .annotation-note-marker', clone).forEach((node) => node.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 5500);
  }

  function setChatContext() {
    const passage = $('.passage');
    const selection = window.getSelection();
    const selectedText = selection?.toString().replace(/\s+/g, ' ').trim() || '';
    const selectionInsidePassage = Boolean(
      passage
      && selectedText
      && selection?.anchorNode
      && selection?.focusNode
      && passage.contains(selection.anchorNode)
      && passage.contains(selection.focusNode)
    );
    chatContext = (selectionInsidePassage ? selectedText : getPassageContext()).slice(0, 5500);
    if (!chatContext) {
      setAiChatStatus('没有可引用的文章内容', 'error');
      return;
    }
    state.aiContext = chatContext;
    if (aiContextButton) {
      aiContextButton.classList.add('has-context');
      aiContextButton.setAttribute('aria-pressed', 'true');
      aiContextButton.textContent = selectionInsidePassage ? '已引用选中文本 ✓' : '已引用当前文章 ✓';
    }
    setAiChatStatus(selectionInsidePassage ? `已引用 ${chatContext.length} 字的选中文本` : `已引用当前文章（${chatContext.length} 字）`, 'success');
    save();
    aiChatInput?.focus();
  }

  function resetChatContext() {
    chatContext = '';
    state.aiContext = '';
    if (aiContextButton) {
      aiContextButton.classList.remove('has-context');
      aiContextButton.setAttribute('aria-pressed', 'false');
      aiContextButton.textContent = '把当前文章作为上下文';
    }
  }

  async function sendAiMessage() {
    const content = aiChatInput?.value.trim() || '';
    if (!content || chatPending) {
      if (!content) setAiChatStatus('请先输入问题', 'error');
      return;
    }

    state.aiMessages.push({ role: 'user', content });
    state.aiMessages = state.aiMessages.slice(-20);
    if (aiChatInput) aiChatInput.value = '';
    chatPending = true;
    if (aiChatSend) aiChatSend.disabled = true;
    if (aiChatInput) aiChatInput.disabled = true;
    setAiChatStatus('DeepSeek 正在思考…', 'loading');
    renderAiChat(true);
    save();

    const recentMessages = state.aiMessages.slice(-12).map((message, index, list) => {
      if (chatContext && index === list.length - 1 && message.role === 'user') {
        return {
          role: 'user',
          content: `[本次问题的文章上下文]\n${chatContext}\n\n[我的问题]\n${message.content}`,
        };
      }
      return { role: message.role, content: message.content };
    });
    const messages = [];
    let requestCharacters = 0;
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
      const message = recentMessages[index];
      if (requestCharacters + message.content.length > 26000 && messages.length) continue;
      messages.unshift(message);
      requestCharacters += message.content.length;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch('/api/deepseek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || `请求失败（${response.status}）`));
      const reply = String(
        data.reply
        || data.content
        || data.choices?.[0]?.message?.content
        || ''
      ).trim();
      if (!reply) throw new Error('DeepSeek 返回了空内容，请重试');
      state.aiMessages.push({ role: 'assistant', content: reply.slice(0, 8000) });
      state.aiMessages = state.aiMessages.slice(-20);
      setAiChatStatus('回答完成', 'success');
      save();
    } catch (error) {
      let message = error?.name === 'AbortError'
        ? '请求超时，请检查网络后重试'
        : String(error?.message || '对话请求失败，请重试');
      if (message.includes('DeepSeek is not configured')) {
        message = '尚未配置 DeepSeek：请复制 .env.example 为 .env，填写服务端密钥并重启服务';
      }
      setAiChatStatus(message, 'error');
      showToast(message);
    } finally {
      clearTimeout(timeout);
      chatPending = false;
      if (aiChatSend) aiChatSend.disabled = false;
      if (aiChatInput) aiChatInput.disabled = false;
      renderAiChat(false);
      aiChatInput?.focus();
    }
  }

  aiChatForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendAiMessage();
  });
  aiChatInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      aiChatForm?.requestSubmit();
    }
  });
  aiContextButton?.addEventListener('click', setChatContext);
  $('#ai-chat-clear')?.addEventListener('click', () => {
    if (chatPending) return;
    state.aiMessages = [];
    resetChatContext();
    renderAiChat();
    setAiChatStatus('对话已清空');
    save();
  });
  $('#open-ai-chat')?.addEventListener('click', () => {
    renderAiChat();
    if (chatContext) {
      if (aiContextButton) {
        aiContextButton.classList.add('has-context');
        aiContextButton.setAttribute('aria-pressed', 'true');
        aiContextButton.textContent = '已引用当前文章 ✓';
      }
      setAiChatStatus(`已保留文章上下文（${chatContext.length} 字）`, 'success');
    }
    setTimeout(() => aiChatInput?.focus(), 180);
  });

  // Utility actions -----------------------------------------------------
  $('#copy-source-text')?.addEventListener('click', async () => {
    const text = $('.passage')?.innerText || '';
    try { await navigator.clipboard.writeText(text); showToast('练习文本已复制'); }
    catch { showToast('请使用浏览器复制功能复制文本'); }
  });
  $('#save-progress')?.addEventListener('click', () => { save(); showToast('学习进度已保存到本机'); });
  $('#next-passage')?.addEventListener('click', () => {
    $('#passage-two')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Passage 2 已为下一阶段练习预留');
  });
  $('#previous-passage')?.addEventListener('click', () => showToast('这是本模块的第一篇阅读'));
  document.addEventListener('keydown', (event) => {
    const wordToken = event.target.closest?.('.word-token[role="button"]');
    if (wordToken && state.markTool === 'select' && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openWordPopover(wordToken);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.closest('input, textarea, [contenteditable="true"]')) {
      event.preventDefault();
      undoAnnotation();
      return;
    }
    if (event.key !== 'Escape') return;
    if (annotationEditor?.classList.contains('is-visible')) closeAnnotationEditor();
    else if (wordLookup?.isOpen()) closeWordPopover();
    else if (activeDrawer) closeDrawer();
    else if (reader.classList.contains('index-open')) reader.classList.remove('index-open');
  });
  addEventListener('beforeunload', () => { save(); stopAudioTimer(); });

  makePassageWordsClickable();
  updateRootState();
  scheduleMarkupRender();
  restoreAnswers();
  renderNotes();
  updateCharCount();
  updateWordBank();
  renderAiChat();
  if (audioRate) audioRate.value = String(state.audioRate);
  updateAudioUI();
})();
