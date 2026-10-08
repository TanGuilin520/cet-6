(() => {
  'use strict';
  const templates = window.WritingTemplates;
  const DRAFT_KEY = 'cet:writing-template-draft:v1';
  const LIBRARY_KEY = 'cet:writing-template-library:v1';
  const ANSWER_DRAFT_KEY = 'cet:writing-answers:v1';
  const pageParams = new URLSearchParams(location.search);
  const suppliedPaper = pageParams.get('paper') || '';
  const paper = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(suppliedPaper) ? suppliedPaper : '';
  const suppliedQuestion = pageParams.get('question') || '';
  const question = /^(?:q[1-9][0-9]{0,2}|writing-[1-9][0-9]{0,2})$/.test(suppliedQuestion) ? suppliedQuestion : '';
  const suppliedPage = pageParams.get('page') || '';
  const pageNumber = /^[1-9][0-9]{0,2}$/.test(suppliedPage) ? Number(suppliedPage) : null;
  const answerContextKey = paper && (question || pageNumber) && (!suppliedQuestion || question) ? `${paper}:${question || `page-${pageNumber}`}` : '';
  const byId = (id) => document.getElementById(id);
  const nameInput = byId('template-name');
  const sourceInput = byId('template-source');
  const status = byId('writing-status');
  const slotFields = byId('slot-fields');
  const paragraphNames = ['intro', 'body', 'conclusion'];
  const paragraphTitles = ['开头段', '主体段', '结尾段'];
  const paragraphInputs = paragraphNames.map((name) => byId(`writing-paragraph-${name}`));
  let editorMode = paragraphInputs.every(Boolean) ? 'paragraphs' : 'full';
  let activeParagraph = paragraphInputs[0];
  let acceptedParagraphs = ['', '', ''];
  let currentId = null;
  let currentKey = makeDraftKey();
  let currentSlots = [];
  let dirty = false;
  let draftTimer = null;
  let draftStorageWritable = true;
  let drafts = { activeKey: '', entries: [] };
  let workspaceScope = answerContextKey ? 'answer' : 'template';
  let templateEditor = null;
  let answerEditor = null;
  let answerDraftBaseline = '';
  let answerStorageWritable = true;
  let answerDraftConflict = false;
  let answerSeeded = false;
  let applySnapshot = null;

  function compiledAnswer() {
    const result = templates.compile({ source: sourceInput.value, slots: currentSlots });
    if (!result.trim()) throw new Error('请先填写本题作文。');
    if (currentSlots.some((slot) => !slot.value.trim()) || /\{\{|\}\}/.test(result)) throw new Error('还有未填写的填空，请完成后再应用到试卷。');
    if (result.length > 12000) throw new Error('成稿最多 12,000 字符，请缩短后再应用。');
    return result.trim();
  }
  function draftAnswer(source, slots) {
    try { const value = templates.compile({ source, slots }); return value.length <= 12000 ? value : ''; } catch (_error) { return ''; }
  }
  function readAnswerDrafts() {
    const raw = localStorage.getItem(ANSWER_DRAFT_KEY);
    if (!raw) return { version: 1, entries: [] };
    const value = JSON.parse(raw);
    window.LearningStore?.validateData?.(ANSWER_DRAFT_KEY, value);
    if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 200) throw new Error('Invalid writing drafts');
    const keys = new Set();
    value.entries.forEach((entry) => {
      if (!entry || typeof entry.contextKey !== 'string' || typeof entry.paper !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry.paper) || keys.has(entry.contextKey)
        || (entry.question && !/^(?:q[1-9][0-9]{0,2}|writing-[1-9][0-9]{0,2})$/.test(entry.question))
        || (!entry.question && (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > 999))
        || entry.contextKey !== `${entry.paper}:${entry.question || `page-${entry.page}`}`
        || typeof entry.source !== 'string' || entry.source.length > 12000 || entry.source.includes('\0')
        || typeof entry.name !== 'string' || entry.name.length > 80 || entry.name.includes('\0')
        || !Array.isArray(entry.slots) || entry.slots.length > 40) throw new Error('Invalid writing draft');
      entry.slots.forEach((slot) => {
        if (!slot || typeof slot.name !== 'string' || slot.name.length > 80 || typeof slot.value !== 'string'
          || slot.value.length > 1000 || slot.value.includes('\0') || !['word', 'sentence'].includes(slot.type)) throw new Error('Invalid writing slot');
      });
      keys.add(entry.contextKey);
    });
    return value;
  }
  function answerSnapshot() {
    const context = window.WritingTaskContext;
    return { contextKey: answerContextKey, paper, question, page: context?.page || pageNumber,
      name: nameInput.value, source: sourceInput.value, slots: currentSlots.map((slot) => ({ ...slot })),
      prompt: typeof context?.prompt === 'string' ? context.prompt.slice(0, 24000) : '',
      answer: draftAnswer(sourceInput.value, currentSlots), updatedAt: new Date().toISOString(),
      verifiedQuestion: context?.status === 'ready' && context.question === question && Boolean(question) };
  }
  function flushAnswerDraft() {
    if (!dirty) return true;
    if (!answerStorageWritable || answerDraftConflict) {
      notify(answerDraftConflict ? '本题草稿已在另一窗口修改，当前输入仍保留；请导出后重新载入另一窗口的草稿。' : '本题草稿存储无法读取，已停止覆盖。请保留页面并导出成稿。', true);
      return false;
    }
    try {
      const store = readAnswerDrafts();
      const index = store.entries.findIndex((entry) => entry.contextKey === answerContextKey);
      const latest = index < 0 ? '' : JSON.stringify(store.entries[index]);
      if (latest !== answerDraftBaseline) {
        answerDraftConflict = true;
        byId('writing-reload-answer').hidden = false;
        throw new Error('本题草稿已在另一窗口修改；为保护双方内容，未覆盖。请导出当前成稿后重新载入。');
      }
      if (index < 0 && store.entries.length >= 200) throw new Error('本题草稿已达 200 份，请先备份学习记录。当前输入仍保留。');
      const draft = answerSnapshot();
      if (index < 0) store.entries.push(draft); else store.entries[index] = draft;
      window.LearningStore?.validateData?.(ANSWER_DRAFT_KEY, store);
      localStorage.setItem(ANSWER_DRAFT_KEY, JSON.stringify(store));
      answerDraftBaseline = JSON.stringify(draft);
      answerEditor = { ...draft, key: answerContextKey, id: null };
      dirty = false;
      byId('draft-state').textContent = '本题草稿已保存';
      return true;
    } catch (error) { notify(error.message || '本题草稿保存失败，请保持页面打开或导出备份。', true); return false; }
  }
  function populateAnswer(draft) {
    currentId = null;
    currentKey = answerContextKey;
    nameInput.value = draft?.name || '';
    sourceInput.value = draft?.source || '';
    currentSlots = (draft?.slots || []).map((slot) => ({ ...slot }));
    dirty = false;
    syncParagraphsFromSource(true);
    renderSlots();
    byId('draft-state').textContent = draft ? '已恢复本题草稿' : '本题独立草稿';
  }
  function loadAnswerDraft() {
    try {
      const entry = readAnswerDrafts().entries.find((item) => item.contextKey === answerContextKey);
      answerDraftBaseline = entry ? JSON.stringify(entry) : '';
      answerEditor = entry || null;
      answerStorageWritable = true;
      answerDraftConflict = false;
      byId('writing-reload-answer').hidden = true;
      if (workspaceScope === 'answer') populateAnswer(entry);
    } catch (_error) {
      answerStorageWritable = false;
      if (workspaceScope === 'answer') populateAnswer(null);
      notify('已有本题草稿无法读取。为保护原有内容，已停止自动写入；可继续编辑并导出。', true);
    }
  }
  function renderWorkspaceScope() {
    ['answer', 'template'].forEach((scope) => byId(`writing-scope-${scope}`)?.setAttribute('aria-pressed', String(scope === workspaceScope)));
    byId('writing-scope-answer').disabled = !answerContextKey;
    byId('writing-name-label').textContent = workspaceScope === 'answer' ? '本题草稿名称（可选）' : '模板名称';
    byId('save-template').textContent = workspaceScope === 'answer' ? '另存为我的模板' : '保存模板';
    byId('delete-template').disabled = workspaceScope === 'answer' || !currentId;
    byId('writing-save-answer').disabled = workspaceScope !== 'answer';
    byId('writing-scope-help').textContent = workspaceScope === 'answer'
      ? `本题作答独立保存（${question || `第 ${pageNumber} 页`}）；点击左侧模板可复制使用，不会改写模板库。`
      : '我的模板可跨试卷复用；保存模板不会替你提交本题答案。';
    document.body.dataset.writingScope = workspaceScope;
    renderApplyState();
  }
  function switchWorkspaceScope(scope) {
    if (scope === workspaceScope || (scope === 'answer' && !answerContextKey)) return;
    if (!flushDraft()) return;
    if (workspaceScope === 'template') templateEditor = { ...snapshot(), dirty };
    else answerEditor = answerSnapshot();
    workspaceScope = scope;
    if (scope === 'answer') { populateAnswer(answerEditor); seedExistingAnswer(); }
    else {
      const draft = templateEditor;
      let record = null;
      try { record = draft?.id ? templates.get(draft.id) : null; } catch (error) { notify(error.message, true); }
      activate(record, draft);
      dirty = Boolean(draft?.dirty);
    }
    renderWorkspaceScope();
  }
  function renderApplyState() {
    const button = byId('writing-apply-answer');
    if (!button) return;
    let reason = '';
    const context = window.WritingTaskContext;
    if (workspaceScope !== 'answer') reason = '当前正在编辑可复用模板；切换到“本题作答”后再应用。';
    else if (!question || context?.question !== question || context?.status !== 'ready') reason = '当前作文尚未绑定已验证的题号；草稿仍可保存，请返回试卷确认作文题后再应用。';
    else if (!window.LearningStore?.applyAnswer) reason = '答题存储暂时不可用，请保存草稿后再试。';
    else {
      try { compiledAnswer(); } catch (error) { reason = error.message; }
    }
    button.disabled = Boolean(reason);
    const state = byId('writing-apply-state');
    state.textContent = reason || '先预览完整成稿，确认后仅更新本题答案，再返回试卷。';
    if (paper && workspaceScope === 'answer' && (!question || context?.question !== question || context?.status !== 'ready')) {
      const review = document.createElement('a');
      review.href = `review.html?exam=${encodeURIComponent(paper)}`;
      review.className = 'text-button';
      review.textContent = '前往复核确认作文题';
      state.append(document.createTextNode(' '), review);
    }
  }
  async function verifyWritingQuestion(expected = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/exams/${encodeURIComponent(paper)}/questions`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('无法重新确认作文题，请保留草稿，稍后重试。');
      const data = await response.json();
      const questions = Array.isArray(data) ? data : data?.questions ?? data?.data?.questions;
      if (!Array.isArray(questions) || questions.length > 500) throw new Error('作文题目列表无法确认，未更新试卷答案。');
      const matches = questions.filter((item) => String(item?.questionId ?? item?.id ?? '') === question);
      if (matches.length !== 1 || matches[0].type !== 'writing') throw new Error('这道作文题已被删除或改为其它题型，请返回试卷确认；当前草稿仍保留。');
      const current = matches[0];
      const revision = Number.isInteger(data?.revision) && data.revision >= 0 ? data.revision : null;
      const fingerprint = JSON.stringify({ page: current.page, stem: current.stem || '', prompt: current.prompt || '', text: current.text || '', bbox: current.bbox || null });
      if (expected && (expected.revision !== null && revision !== expected.revision || fingerprint !== expected.fingerprint)) throw new Error('试卷题目版本已变化，请返回原题核验后重新预览，当前草稿未被覆盖。');
      return { revision, fingerprint };
    } catch (error) { throw error.name === 'AbortError' ? new Error('确认题目超时，请保存草稿后重试。') : error; }
    finally { clearTimeout(timer); }
  }
  async function previewApply() {
    const button = byId('writing-apply-answer');
    button.disabled = true;
    try {
      if (workspaceScope !== 'answer' || window.WritingTaskContext?.status !== 'ready' || window.WritingTaskContext?.question !== question || !question) throw new Error('未确认作文题号，不能应用到试卷。');
      const answer = compiledAnswer();
      const context = window.WritingTaskContext;
      const loadedQuestion = context.questionFingerprint ? { revision: context.revision, fingerprint: context.questionFingerprint } : null;
      const questionState = await verifyWritingQuestion(loadedQuestion);
      if (workspaceScope !== 'answer' || answer !== compiledAnswer()) throw new Error('确认过程中正文已变化，请重新预览。');
      const stored = window.LearningStore.readExam(paper);
      const previous = stored.answers?.[question] || '';
      applySnapshot = { paper, question, answer, expectedAnswer: previous, questionState };
      byId('writing-apply-context').textContent = `${question} · ${wordCount(answer)} 词（估算）。请对照原题确认内容。`;
      byId('writing-apply-preview').textContent = answer;
      byId('writing-apply-warning').textContent = previous && previous !== answer ? '本题已有答案；应用时会再次确认覆盖。其它题目和标注不会改变。' : '确认后仅保存这一道作文题的答案；我的模板不变。';
      byId('writing-apply-dialog').showModal();
    } catch (error) { notify(error.message, true); }
    finally { renderApplyState(); }
  }
  async function confirmApply() {
    if (!applySnapshot) return;
    const button = byId('writing-apply-confirm');
    button.disabled = true;
    try {
      const snapshot = applySnapshot;
      if (snapshot.answer !== compiledAnswer()) throw new Error('成稿已变化，请关闭预览后重新确认。');
      if (snapshot.expectedAnswer && snapshot.expectedAnswer !== snapshot.answer && !window.confirm('本题已有答案，确定用当前成稿覆盖吗？其它题目与标注保持不变。')) return;
      await verifyWritingQuestion(snapshot.questionState);
      if (workspaceScope !== 'answer' || snapshot.answer !== compiledAnswer()) throw new Error('确认过程中草稿已变化，请关闭预览后重新确认。');
      if (!flushDraft()) return;
      await window.LearningStore.applyAnswer(snapshot);
      byId('writing-apply-dialog').close();
      dirty = false;
      location.assign(byId('back-to-reader').href);
    } catch (error) { byId('writing-apply-warning').textContent = error.message; notify(error.message, true); }
    finally { button.disabled = false; }
  }

  function makeDraftKey() { return `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function notify(text, isError = false) {
    status.textContent = text;
    status.dataset.error = String(isError);
  }
  function sourceParagraphs(source) {
    // Blank lines are explicit paragraph boundaries. A sentence or a single
    // line break never gives us permission to invent another paragraph.
    return source ? source.split(/\r?\n[ \t]*\r?\n/) : [];
  }
  function composeParagraphs(values) {
    let last = values.length - 1;
    while (last >= 0 && values[last] === '') last -= 1;
    return values.slice(0, last + 1).join('\n\n');
  }
  function showEditingMode(mode) {
    editorMode = mode;
    if (byId('writing-paragraph-editor')) byId('writing-paragraph-editor').hidden = mode !== 'paragraphs';
    if (byId('writing-full-editor')) byId('writing-full-editor').hidden = mode !== 'full';
    ['paragraphs', 'full'].forEach((value) => {
      const button = byId(`writing-mode-${value}`);
      button?.setAttribute('aria-pressed', String(value === mode));
    });
  }
  function syncParagraphsFromSource(autoMode = false) {
    if (!paragraphInputs.every(Boolean)) return;
    const parts = sourceParagraphs(sourceInput.value);
    const canUseThree = parts.length <= 3;
    if (canUseThree) {
      acceptedParagraphs = paragraphInputs.map((input, index) => {
        input.value = parts[index] || '';
        return input.value;
      });
    }
    const state = byId('writing-structure-state');
    if (state) state.textContent = canUseThree
      ? '按空行区分段落；开头、主体、结尾均可使用自己的模板和填空，不预填范文。'
      : `这份正文有 ${parts.length} 个段落，已保留完整正文；不会自动删段或重新分配句子。`;
    if (autoMode) { showEditingMode(canUseThree ? 'paragraphs' : 'full'); activeParagraph = paragraphInputs[0]; }
  }
  function switchEditingMode(mode) {
    if (mode === 'paragraphs' && sourceParagraphs(sourceInput.value).length > 3) {
      notify('正文超过三段，已保留完整内容。请在“完整正文”中自行整理后，再切换三段编辑。', true);
      return;
    }
    if (mode === 'paragraphs') syncParagraphsFromSource();
    showEditingMode(mode);
    renderPreview();
  }
  function wordCount(text) {
    const withoutEmptySlots = text.replace(/\{\{[^{}]*\}\}/g, ' ');
    return (withoutEmptySlots.match(/[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+)*|\d+(?:[.,]\d+)*/g) || []).length;
  }
  function renderComposition(compiled) {
    const preview = byId('writing-paragraph-preview');
    const canShowThree = editorMode === 'paragraphs' && sourceParagraphs(sourceInput.value).length <= 3;
    if (preview) {
      preview.hidden = !canShowThree;
      if (canShowThree) {
        preview.replaceChildren(...paragraphInputs.map((input, index) => {
          let text = input.value;
          try { text = templates.compile({ source: text, slots: currentSlots }); } catch (_error) { /* Keep unfinished placeholder text editable. */ }
          const section = document.createElement('section');
          section.dataset.previewParagraph = paragraphNames[index];
          const heading = document.createElement('h4');
          heading.textContent = `${index + 1} · ${paragraphTitles[index]}`;
          const body = document.createElement('p');
          body.className = 'preview-paragraph-text';
          body.textContent = text || '这一段还没有填写。';
          section.append(heading, body);
          return section;
        }));
      }
    }
    byId('template-preview').hidden = Boolean(preview && canShowThree);
    paragraphInputs.forEach((input, index) => {
      if (!input) return;
      let text = input.value;
      try { text = templates.compile({ source: text, slots: currentSlots }); } catch (_error) { /* Incomplete slots are not answers. */ }
      const counter = byId(`writing-paragraph-${paragraphNames[index]}-count`);
      if (counter) counter.textContent = `${wordCount(text)} 词`;
    });
    const total = wordCount(compiled);
    if (byId('writing-word-count')) byId('writing-word-count').textContent = String(total);
    const lengthState = byId('writing-length-state');
    if (lengthState) {
      const limit = window.WritingTaskContext?.wordLimit;
      const known = limit && Number.isInteger(limit.min) && Number.isInteger(limit.max) && limit.min > 0 && limit.max >= limit.min;
      lengthState.dataset.state = !known ? 'unknown' : total < limit.min ? 'short' : total > limit.max ? 'long' : 'within';
      lengthState.textContent = !known ? '词数为估算；未识别出题目字数范围，请对照原题。'
        : total < limit.min ? `题目要求 ${limit.min}–${limit.max} 词，还需约 ${limit.min - total} 词。`
          : total > limit.max ? `题目要求 ${limit.min}–${limit.max} 词，当前超出约 ${total - limit.max} 词。`
            : `当前估算词数在题目要求 ${limit.min}–${limit.max} 词范围内。`;
    }
  }
  function editParagraph(input) {
    const values = paragraphInputs.map((field) => field.value);
    const source = composeParagraphs(values);
    if (source.length > 12000 || source.includes('\0')) {
      const index = paragraphInputs.indexOf(input);
      input.value = acceptedParagraphs[index];
      notify('三段正文合计最多 12,000 字符，且不能包含 NUL 字符；本次超限修改未应用，原有内容仍保留。', true);
      return;
    }
    acceptedParagraphs = [...values];
    sourceInput.value = source;
    renderSlots();
    scheduleDraft();
  }
  function snapshot() {
    return { key: currentKey, id: currentId, name: nameInput.value, source: sourceInput.value, slots: currentSlots.map((slot) => ({ ...slot })), updatedAt: new Date().toISOString() };
  }
  function writeDrafts() {
    if (!draftStorageWritable) { notify('草稿存储不可用，当前输入仍在页面中。请保存模板或导出备份后再离开。', true); return false; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); renderDraftList(); return true; }
    catch (_error) { notify('草稿保存失败，当前输入没有清空。请保持页面打开，或导出备份；已保存的模板没有被覆盖。', true); return false; }
  }
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (workspaceScope === 'answer') return flushAnswerDraft();
    if (!dirty) return true;
    const draft = snapshot();
    const index = drafts.entries.findIndex((entry) => entry.key === currentKey);
    if (index < 0 && drafts.entries.length >= 40) {
      notify('草稿数量已达 40 份，请先保存当前模板。当前输入仍保留在页面中。', true);
      return false;
    }
    if (index < 0) drafts.entries.push(draft);
    else drafts.entries[index] = draft;
    drafts.activeKey = currentKey;
    return writeDrafts();
  }
  function scheduleDraft() {
    dirty = true;
    byId('draft-state').textContent = '有未保存的修改';
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (flushDraft()) byId('draft-state').textContent = workspaceScope === 'answer' ? '本题草稿已保留' : '草稿已保留';
    }, 180);
  }
  function readDrafts() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length > 40 || typeof parsed.activeKey !== 'string') throw new Error('Invalid drafts');
      parsed.entries.forEach((entry) => {
        if (!entry || typeof entry.key !== 'string' || typeof entry.name !== 'string' || entry.name.length > 80 || typeof entry.source !== 'string' || entry.source.length > 12000 || entry.source.includes('\0') || !Array.isArray(entry.slots) || entry.slots.length > 40) throw new Error('Invalid draft');
        entry.slots.forEach((slot) => {
          if (!slot || typeof slot.name !== 'string' || typeof slot.value !== 'string' || slot.value.length > 1000 || slot.value.includes('\0')) throw new Error('Invalid draft slot');
        });
        if (entry.id !== null && (typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(entry.id))) throw new Error('Invalid draft ID');
      });
      drafts = parsed;
    } catch (_error) {
      draftStorageWritable = false;
      notify('草稿数据暂时无法读取。为保护原有草稿，已停止自动写入；你仍可编辑、保存模板和导出。', true);
    }
  }
  function renderLibrary() {
    const container = byId('template-list');
    try {
      const records = templates.list();
      byId('template-count').textContent = `${records.length} / 30`;
      const nodes = records.map((record) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'template-card';
        button.dataset.templateId = record.id;
        button.setAttribute('aria-current', String(record.id === currentId));
        const heading = document.createElement('strong');
        heading.textContent = record.name;
        const detail = document.createElement('small');
        detail.textContent = `${record.slots.length} 个填空 · ${record.slots.filter((slot) => slot.value).length} 个已填写`;
        button.append(heading, detail);
        button.addEventListener('click', () => selectTemplate(record.id));
        return button;
      });
      if (!nodes.length) {
        const empty = document.createElement('p');
        empty.className = 'library-empty';
        empty.textContent = '还没有保存的模板。添加你自己的模板，或导入 TXT / MD 文件。';
        nodes.push(empty);
      }
      container.replaceChildren(...nodes);
    } catch (error) { notify(error.message, true); }
  }
  function renderDraftList() {
    byId('draft-section').hidden = !drafts.entries.length;
    byId('draft-list').replaceChildren(...drafts.entries.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'template-card';
      button.dataset.draftKey = entry.key;
      const title = document.createElement('strong');
      title.textContent = entry.name || '未命名草稿';
      const detail = document.createElement('small');
      detail.textContent = entry.id ? '已有模板的未保存修改' : '新模板 · 尚未正式保存';
      button.append(title, detail);
      button.addEventListener('click', () => {
        if (workspaceScope !== 'template') switchWorkspaceScope('template');
        if (workspaceScope !== 'template') return;
        if (!flushDraft()) return;
        try {
          // flushDraft replaces the active snapshot. Never restore the stale
          // object captured by a button before the latest keystrokes.
          const fresh = drafts.entries.find((item) => item.key === entry.key);
          if (!fresh) return;
          const record = fresh.id ? templates.get(fresh.id) : null;
          if (fresh.id && !record) fresh.id = null;
          activate(record, fresh);
          drafts.activeKey = fresh.key;
          writeDrafts();
        } catch (error) { notify(error.message, true); }
      });
      return button;
    }));
  }
  function renderPreview() {
    try {
      const compiled = templates.compile({ source: sourceInput.value, slots: currentSlots });
      byId('template-preview').textContent = compiled || '在左侧放入模板，即可在这里看到预览。';
      renderComposition(compiled);
      renderApplyState();
      return true;
    } catch (error) {
      byId('template-preview').textContent = sourceInput.value || '在左侧放入模板，即可在这里看到预览。';
      renderComposition(sourceInput.value);
      renderApplyState();
      notify(error.message, true);
      return false;
    }
  }
  function renderSlots() {
    try {
      currentSlots = templates.parse(sourceInput.value, currentSlots);
      byId('slot-count').textContent = `${currentSlots.length} 个填空`;
      byId('slot-help').textContent = currentSlots.length
        ? '点击对应填空，补充你的词汇或句子；内容会同步到预览，保存后才更新模板库。'
        : '正文中还没有填空。可选中文字转换，或插入一个单词 / 句子填空；也可以直接保存为固定段落。';
      const fields = currentSlots.map((slot, index) => {
        const field = document.createElement('div');
        field.className = 'slot-field';
        const heading = document.createElement('div');
        heading.className = 'slot-field-heading';
        const title = document.createElement('label');
        title.htmlFor = `writing-slot-${index}`;
        title.textContent = slot.name;
        const type = document.createElement('select');
        type.dataset.slotType = slot.name;
        type.setAttribute('aria-label', `${slot.name} 填空类型`);
        [['word', '单词 / 短语'], ['sentence', '句子']].forEach(([value, text]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          type.append(option);
        });
        type.value = slot.type;
        type.addEventListener('change', () => {
          slot.type = type.value;
          renderSlots();
          scheduleDraft();
          const replacement = [...slotFields.querySelectorAll('[data-slot-type]')].find((element) => element.dataset.slotType === slot.name);
          replacement?.focus();
          if (slot.type === 'word' && /[\r\n]/.test(slot.value)) notify('填空已改为单词 / 短语，原有多行内容仍然保留，你可以按需整理。');
        });
        const limit = document.createElement('small');
        limit.textContent = '最多 1,000 字符';
        const tools = document.createElement('div');
        tools.className = 'slot-field-type';
        tools.append(type, limit);
        heading.append(title, tools);
        // A text input strips line breaks, so retain a textarea for an existing
        // multi-line value rather than silently altering it during a type change.
        const singleLineWord = slot.type === 'word' && !/[\r\n]/.test(slot.value);
        const input = document.createElement(singleLineWord ? 'input' : 'textarea');
        input.id = `writing-slot-${index}`;
        input.dataset.slotName = slot.name;
        input.maxLength = 1000;
        input.value = slot.value;
        input.placeholder = slot.type === 'word' ? '填入你的单词或短语' : '填入你自己的句子';
        if (singleLineWord) input.type = 'text';
        else input.rows = 3;
        input.addEventListener('input', () => {
          slot.value = input.value;
          renderPreview();
          scheduleDraft();
        });
        field.append(heading, input);
        return field;
      });
      slotFields.replaceChildren(...fields);
      renderPreview();
      return true;
    } catch (error) {
      byId('slot-help').textContent = error.message;
      renderPreview();
      notify(error.message, true);
      return false;
    }
  }
  function activate(record, draft) {
    currentId = record ? record.id : (draft ? draft.id : null);
    currentKey = draft ? draft.key : (record ? record.id : makeDraftKey());
    nameInput.value = draft ? draft.name : (record ? record.name : '');
    sourceInput.value = draft ? draft.source : (record ? record.source : '');
    currentSlots = (draft ? draft.slots : (record ? record.slots : [])).map((slot) => ({ ...slot }));
    dirty = Boolean(draft);
    byId('draft-state').textContent = draft ? '已恢复编辑草稿' : (record ? '已保存模板' : '新模板');
    byId('delete-template').disabled = !currentId;
    byId('slot-name').value = '';
    syncParagraphsFromSource(true);
    renderSlots();
    renderLibrary();
    renderDraftList();
    if (draft) notify('已恢复这份模板的编辑草稿，尚未覆盖模板库中的已保存版本。');
  }
  function selectTemplate(id) {
    if (workspaceScope === 'answer') {
      try {
        const record = templates.get(id);
        if (!record) throw new Error('这份模板已被删除，请重新选择。');
        if (sourceInput.value.trim() && !window.confirm('用这份模板替换当前本题草稿的正文吗？模板库中的原模板保持不变。')) return;
        if (!flushDraft()) return;
        nameInput.value = record.name;
        sourceInput.value = record.source;
        currentSlots = record.slots.map((slot) => ({ ...slot }));
        syncParagraphsFromSource(true);
        renderSlots();
        scheduleDraft();
        selectMobileTab('answer');
        notify(`已复制“${record.name}”到本题草稿；之后的修改不影响原模板。`);
      } catch (error) { notify(error.message, true); }
      return;
    }
    if (currentId === id) return;
    if (!flushDraft()) return;
    try {
      const record = templates.get(id);
      if (!record) throw new Error('这份模板已被删除，请重新选择。');
      const draft = drafts.entries.find((entry) => entry.id === id);
      activate(record, draft);
      drafts.activeKey = currentKey;
      if (drafts.entries.length) writeDrafts();
      if (!draft) notify(`已打开“${record.name}”。修改和填空后请点击保存模板。`);
    } catch (error) { notify(error.message, true); }
  }
  function newTemplate() {
    if (workspaceScope !== 'template') switchWorkspaceScope('template');
    if (workspaceScope !== 'template') return;
    if (!flushDraft()) return;
    activate(null, null);
    drafts.activeKey = currentKey;
    if (drafts.entries.length) writeDrafts();
    notify('已新建空白模板。此前的未保存内容仍保留在草稿中，刷新后可恢复最近编辑的草稿。');
    selectMobileTab('answer');
    nameInput.focus();
  }
  function insertSlot(type, selectionRequired = false) {
    const target = editorMode === 'paragraphs' ? activeParagraph : sourceInput;
    if (!target) return;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selected = target.value.slice(start, end);
    if (selectionRequired && !selected) { notify('请先在模板正文中选中文字，再点击“选中文字 → 填空”。', true); target.focus(); return; }
    if (selected.length > 1000) { notify('选中的内容超过 1,000 字符，请缩小范围后再转换成填空。', true); return; }
    let parsed;
    try { parsed = templates.parse(sourceInput.value, currentSlots); }
    catch (error) { notify(error.message, true); return; }
    let name = byId('slot-name').value.trim();
    if (!name) {
      const base = type === 'word' ? '单词' : '句子';
      let index = 1;
      while (parsed.some((slot) => slot.name === `${base}${index}`)) index += 1;
      name = `${base}${index}`;
    }
    if (/[{}\r\n]/.test(name)) { notify('填空名称不能含有大括号或换行。', true); return; }
    const replacement = target.value.slice(0, start) + `{{${name}}}` + target.value.slice(end);
    const source = editorMode === 'paragraphs' ? composeParagraphs(paragraphInputs.map((input) => input === target ? replacement : input.value)) : replacement;
    const provided = parsed.filter((slot) => slot.name !== name);
    const existing = parsed.find((slot) => slot.name === name);
    provided.push({ name, type: existing ? existing.type : type, value: existing ? existing.value : selected });
    try { currentSlots = templates.parse(source, provided); }
    catch (error) { notify(error.message, true); return; }
    sourceInput.value = source;
    if (editorMode === 'paragraphs') {
      target.value = replacement;
      acceptedParagraphs = paragraphInputs.map((input) => input.value);
    } else syncParagraphsFromSource();
    const cursor = start + name.length + 4;
    target.focus();
    target.setSelectionRange(cursor, cursor);
    renderSlots();
    scheduleDraft();
    notify(selected ? `已将选中文字变成“${name}”填空，并保留原内容供你修改。` : `已插入“${name}”填空，请在右侧填写。`);
  }
  function saveTemplate() {
    try {
      const saved = templates.save({ id: workspaceScope === 'template' ? currentId || undefined : undefined, name: nameInput.value, source: sourceInput.value, slots: currentSlots });
      if (workspaceScope === 'answer') {
        renderLibrary();
        scheduleDraft();
        notify(`已保存“${saved.name}”为独立模板。本题草稿仍独立保留，尚未应用到试卷。`);
        return;
      }
      const oldKey = currentKey;
      currentId = saved.id;
      currentKey = saved.id;
      currentSlots = saved.slots;
      nameInput.value = saved.name;
      dirty = false;
      clearTimeout(draftTimer);
      draftTimer = null;
      drafts.entries = drafts.entries.filter((entry) => entry.key !== oldKey && entry.id !== saved.id);
      drafts.activeKey = currentKey;
      const cleared = writeDrafts();
      byId('delete-template').disabled = false;
      byId('draft-state').textContent = '已保存模板';
      renderSlots();
      renderLibrary();
      notify(cleared ? `“${saved.name}”已保存，可在试卷写作题中选择使用。${saved.slots.length ? '' : '这份正文没有填空，已作为固定段落保存。'}` : '模板已保存，但草稿缓存未能更新；当前输入与已保存版本都保留。', !cleared);
    } catch (error) {
      notify(error.message, true);
      // Keep every field and draft intact when the library write fails.
      dirty = true;
    }
  }
  function deleteTemplate() {
    if (!currentId || !window.confirm('确定删除这份已保存的模板吗？删除后无法恢复，请先导出需要保留的内容。')) return;
    try {
      const id = currentId;
      templates.remove(id);
      drafts.entries = drafts.entries.filter((entry) => entry.id !== id);
      dirty = false;
      clearTimeout(draftTimer);
      activate(null, null);
      drafts.activeKey = currentKey;
      const cleared = writeDrafts();
      notify(cleared ? '模板已从当前浏览器删除。' : '已保存模板已删除，但草稿缓存未能清除，请检查浏览器本地存储。', !cleared);
    } catch (error) { notify(error.message, true); }
  }
  async function importTemplate(file) {
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) { byId('template-file').value = ''; notify('请选择 TXT 或 MD 文件。', true); return; }
    if (file.size > 64 * 1024) { byId('template-file').value = ''; notify('导入文件不能超过 64 KB，请先缩小内容。', true); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const parsed = templates.parse(text);
      if (!text.trim()) throw new Error('文件为空，请选择包含模板正文的文件。');
      if (workspaceScope === 'answer' && sourceInput.value.trim() && !window.confirm('将导入正文替换当前本题草稿吗？已有模板库不会改变。')) return;
      if (!flushDraft()) return;
      if (workspaceScope === 'template') activate(null, null);
      nameInput.value = file.name.replace(/\.(txt|md)$/i, '').slice(0, 80);
      sourceInput.value = text;
      currentSlots = parsed;
      syncParagraphsFromSource(true);
      renderSlots();
      scheduleDraft();
      notify(`已导入“${file.name}”到${workspaceScope === 'answer' ? '本题' : '新模板'}草稿。${parsed.length ? '请检查并填写填空。' : '文件没有填空，可选中文字转换，或直接编辑。'}模板库不会自动改变。`);
    } catch (error) {
      notify(error instanceof TypeError ? '文件不是有效的 UTF-8 文本，请以 UTF-8 编码重新保存。原有输入未被更改。' : error.message, true);
    } finally { byId('template-file').value = ''; }
  }
  function exportTemplate(originalSource = false) {
    try {
      if (!sourceInput.value.trim()) throw new Error('请先放入模板正文，再导出。');
      // Validate both variants, but preserve original placeholders in a reusable backup.
      const compiled = templates.compile({ source: sourceInput.value, slots: currentSlots });
      const text = originalSource ? sourceInput.value : compiled;
      const url = URL.createObjectURL(new Blob([text], { type: `${originalSource ? 'text/markdown' : 'text/plain'};charset=utf-8` }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(nameInput.value.trim() || '我的作文模板').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)}.${originalSource ? 'md' : 'txt'}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(originalSource ? '已导出原模板 MD，保留所有填空位置，可再次导入复用。填写值仍保留在当前浏览器的模板或草稿中。' : '已导出当前预览为 TXT。未填写的部分仍保留为填空，模板库不会自动更新。');
    } catch (error) { notify(error.message, true); }
  }

  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(paper)) {
    const back = byId('back-to-reader');
    const returnParams = new URLSearchParams({ paper, cachefix: '20261008-learning-loop-1' });
    const returnPage = pageParams.get('page') || '';
    if (/^[1-9][0-9]{0,2}$/.test(returnPage)) {
      returnParams.set('page', returnPage);
      back.textContent = '返回当前试卷页';
    }
    const question = pageParams.get('question') || '';
    if (/^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/.test(question)) {
      returnParams.set('question', question);
      back.textContent = '返回当前题目';
    }
    back.href = `reader.html?${returnParams}`;
    byId('writing-bottom-back').href = back.href;
    byId('writing-bottom-back').hidden = false;
    byId('open-translation-library').href = `translation.html?${returnParams}`;
    back.hidden = false;
  }
  nameInput.addEventListener('input', scheduleDraft);
  sourceInput.addEventListener('input', () => { syncParagraphsFromSource(); renderSlots(); scheduleDraft(); });
  paragraphInputs.forEach((input) => {
    input?.addEventListener('focus', () => { activeParagraph = input; });
    input?.addEventListener('input', () => editParagraph(input));
  });
  byId('writing-mode-paragraphs')?.addEventListener('click', () => switchEditingMode('paragraphs'));
  byId('writing-mode-full')?.addEventListener('click', () => switchEditingMode('full'));
  function seedExistingAnswer() {
    const context = window.WritingTaskContext;
    if (answerSeeded || context?.status !== 'ready' || !question || context.question !== question) return;
    if (workspaceScope !== 'answer') return;
    answerSeeded = true;
    if (dirty || sourceInput.value.trim() || answerDraftBaseline || !answerStorageWritable) return;
    try {
      const answer = window.LearningStore?.readExam(paper)?.answers?.[question] || '';
      if (!answer) return;
      if (typeof answer !== 'string' || answer.length > 12000 || answer.includes('\0')) throw new Error('试卷中的已有答案无法安全读取，请返回试卷查看。');
      sourceInput.value = answer;
      currentSlots = templates.parse(answer);
      syncParagraphsFromSource(true);
      renderSlots();
      scheduleDraft();
      notify('已载入这道题的现有作答，可继续编辑；修改不会自动覆盖试卷答案。');
    } catch (error) { notify(error.message, true); }
  }
  function selectMobileTab(tab) {
    byId('writing-paragraph-editor')?.closest('.writing-workspace')?.setAttribute('data-mobile-tab', tab);
    document.querySelectorAll('[data-writing-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.writingTab === tab)));
  }
  byId('writing-scope-answer').addEventListener('click', () => switchWorkspaceScope('answer'));
  byId('writing-scope-template').addEventListener('click', () => switchWorkspaceScope('template'));
  byId('writing-save-answer').addEventListener('click', () => {
    if (workspaceScope === 'answer' && flushDraft()) notify('本题草稿已保存；试卷中的正式答案尚未改变。');
  });
  byId('writing-apply-answer').addEventListener('click', previewApply);
  byId('writing-apply-confirm').addEventListener('click', confirmApply);
  byId('writing-apply-cancel').addEventListener('click', () => { byId('writing-apply-dialog').close(); applySnapshot = null; });
  byId('writing-reload-answer').addEventListener('click', () => {
    if (dirty && !window.confirm('重新载入会放弃本页尚未保存的修改。请先导出当前成稿，确定继续吗？')) return;
    clearTimeout(draftTimer);
    dirty = false;
    loadAnswerDraft();
    renderWorkspaceScope();
  });
  byId('writing-toggle-task').addEventListener('click', (event) => {
    const collapsed = byId('writing-task-panel').classList.toggle('is-collapsed');
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.textContent = collapsed ? '展开题目' : '收起题目';
  });
  byId('writing-focus-mode').addEventListener('click', (event) => {
    const focused = document.body.classList.toggle('is-writing-focused');
    event.currentTarget.setAttribute('aria-pressed', String(focused));
    event.currentTarget.textContent = focused ? '退出专注' : '专注编辑';
  });
  document.querySelectorAll('[data-writing-tab]').forEach((button) => button.addEventListener('click', () => selectMobileTab(button.dataset.writingTab)));
  window.addEventListener('writing-task-loaded', () => { seedExistingAnswer(); renderPreview(); renderWorkspaceScope(); });
  byId('new-template').addEventListener('click', newTemplate);
  byId('insert-word-slot').addEventListener('click', () => insertSlot('word'));
  byId('insert-sentence-slot').addEventListener('click', () => insertSlot('sentence'));
  byId('selection-to-slot').addEventListener('click', () => insertSlot('sentence', true));
  byId('save-template').addEventListener('click', saveTemplate);
  byId('delete-template').addEventListener('click', deleteTemplate);
  byId('template-file').addEventListener('change', (event) => importTemplate(event.target.files[0]));
  byId('export-template').addEventListener('click', () => exportTemplate(false));
  byId('export-source').addEventListener('click', () => exportTemplate(true));
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || new URL(link.href, location.href).origin !== location.origin) return;
    if (dirty && !flushDraft()) {
      event.preventDefault();
      notify('草稿尚未保存，已暂停跳转；请保存模板或导出备份后再离开。当前输入没有清空。', true);
    }
  });
  window.addEventListener('pagehide', flushDraft);
  window.addEventListener('beforeunload', (event) => {
    // A denied/quota-limited storage write must not silently discard the only copy.
    if (dirty && !flushDraft()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === LIBRARY_KEY) renderLibrary();
    if (event.key === ANSWER_DRAFT_KEY && answerContextKey) {
      try {
        const entry = readAnswerDrafts().entries.find((item) => item.contextKey === answerContextKey);
        const latest = entry ? JSON.stringify(entry) : '';
        if (latest === answerDraftBaseline) return;
        if (workspaceScope === 'answer' && dirty) {
          answerDraftConflict = true;
          byId('writing-reload-answer').hidden = false;
          notify('本题草稿已在另一窗口修改，已暂停自动覆盖。请导出当前成稿后重新载入。', true);
        } else loadAnswerDraft();
      } catch (_error) { answerStorageWritable = false; notify('另一窗口写入了无法读取的草稿，已停止覆盖。', true); }
    }
  });
  readDrafts();
  const activeDraft = drafts.entries.find((entry) => entry.key === drafts.activeKey);
  if (activeDraft) {
    try {
      const record = activeDraft.id ? templates.get(activeDraft.id) : null;
      if (activeDraft.id && !record) activeDraft.id = null;
      activate(record, activeDraft);
    } catch (error) { activate(null, activeDraft); notify(error.message, true); }
  } else {
    try {
      const record = drafts.activeKey ? templates.get(drafts.activeKey) : null;
      if (record) activate(record, null);
      else if (drafts.entries.length) activate(null, drafts.entries[drafts.entries.length - 1]);
      else { renderLibrary(); renderSlots(); renderDraftList(); }
    } catch (error) { renderLibrary(); renderSlots(); renderDraftList(); notify(error.message, true); }
  }
  templateEditor = { ...snapshot(), dirty };
  if (answerContextKey) loadAnswerDraft();
  renderWorkspaceScope();
  document.body.dataset.hasWritingTask = String(Boolean(answerContextKey));
  window.LearningStore?.mountExpressions?.({ container: byId('writing-expression-library'),
    getTarget: () => { selectMobileTab('answer'); return editorMode === 'paragraphs' ? activeParagraph : sourceInput; },
    context: { paper, question: paper ? question : '', page: pageNumber, module: 'writing' } });
})();
