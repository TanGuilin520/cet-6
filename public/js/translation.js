(() => {
  'use strict';
  const METHOD_KEY = 'cet:translation-method:v1';
  const NOTES_KEY = 'cet:translation-notes:v1';
  const DRAFTS_KEY = 'cet:translation-note-drafts:v1';
  const MAX_METHOD_CHARS = 24000;
  const MAX_FIELD_CHARS = 12000;
  const MAX_RECORDS = 200;
  const fields = {
    original: document.getElementById('translation-source-text'),
    firstDraft: document.getElementById('translation-first-draft'),
    revised: document.getElementById('translation-revised-text'),
    reason: document.getElementById('translation-revision-reason'),
    method: document.getElementById('translation-used-method'),
    freeNote: document.getElementById('translation-free-note'),
  };
  const methodInput = document.getElementById('translation-method-source');
  const status = document.getElementById('translation-status');
  const methodState = document.getElementById('translation-method-state');
  const noteState = document.getElementById('translation-note-state');
  const params = new URLSearchParams(location.search);
  const suppliedPaper = params.get('paper') || '';
  const paper = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(suppliedPaper) ? suppliedPaper : '';
  const suppliedQuestion = params.get('question') || '';
  const question = paper && /^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/.test(suppliedQuestion) ? suppliedQuestion : '';
  const suppliedPage = params.get('page') || '';
  const page = paper && /^[1-9][0-9]{0,2}$/.test(suppliedPage) ? Number(suppliedPage) : null;
  const contextKey = paper ? `${paper}:${question ? `question:${question}` : `page:${page || 1}`}` : 'personal';
  let methodDirty = false;
  let noteDirty = false;
  let noteRestored = false;
  let savedNoteBaseline = null;
  let draftTimer = null;
  let draftsWritable = true;
  let drafts = { version: 1, method: null, notes: [] };
  let methodRefs = [];
  let verifiedQuestion = null;
  let verifiedRevision = null;
  let activeTarget = fields.revised;
  let pendingAnswer = null;
  let aiBusy = false;
  let aiMode = 'hint';
  let aiHistory = [];
  let aiComposing = false;
  let aiConsentEpoch = 0;
  let aiController = null;
  let aiStopped = false;
  let aiResetBusy = false;
  let aiRuntime = null;
  let aiRequestAuthorizedId = '';
  let aiWithdrawalNotice = '';
  let aiMemoryClearPromise = null;
  const aiPendingMemoryClears = new Set();
  const AI_CONVERSATION_KEY = `cet:translation-ai:${contextKey}:v1`;
  let aiConversations = {};
  try {
    const saved = JSON.parse(localStorage.getItem(AI_CONVERSATION_KEY) || '{}');
    aiConversations = saved?._consentPersonal === true ? {} : window.AgentChat.normalizeConversations(saved);
    const pending = [...(Array.isArray(saved?._pendingMemoryClears) ? saved._pendingMemoryClears : []), ...(saved?._consentPersonal === true && typeof saved?._authorizedConversationId === 'string' ? [saved._authorizedConversationId] : [])];
    pending.slice(0, 40).forEach((id) => { if (window.AgentChat.normalizeConversations({ general: id }).general) aiPendingMemoryClears.add(id); });
  } catch (_error) { /* Broken optional conversation IDs never overwrite learning records. */ }
  const aiPanel = document.querySelector('.translation-ai-panel');
  const runtimeState = document.createElement('p'); runtimeState.id = 'translation-ai-runtime'; runtimeState.className = 'translation-ai-runtime'; runtimeState.textContent = '正在检查 AI 运行状态…';
  aiPanel.querySelector('h3').after(runtimeState);
  const aiActions = document.createElement('div'); aiActions.className = 'translation-ai-actions';
  const aiStopButton = document.createElement('button'); aiStopButton.id = 'stop-translation-ai'; aiStopButton.type = 'button'; aiStopButton.className = 'secondary-button'; aiStopButton.textContent = '停止生成'; aiStopButton.hidden = true;
  const aiNewButton = document.createElement('button'); aiNewButton.id = 'new-translation-ai'; aiNewButton.type = 'button'; aiNewButton.className = 'secondary-button'; aiNewButton.textContent = '新建对话';
  aiActions.append(aiStopButton, aiNewButton); document.getElementById('send-translation-ai').after(aiActions);
  function translationAiScope() { return verifiedQuestion && question ? 'question' : 'selection'; }
  function translationConversationKey() { return translationAiScope() === 'question' ? `question:${question}` : 'selection'; }
  function saveAiConversations() { try { localStorage.setItem(AI_CONVERSATION_KEY, JSON.stringify({ ...aiConversations, _consentPersonal: document.getElementById('translation-ai-consent').checked, _authorizedConversationId: aiRequestAuthorizedId, _pendingMemoryClears: [...aiPendingMemoryClears] })); } catch (_error) { document.getElementById('translation-ai-state').textContent = '会话标识暂未能保存，当前笔记未受影响。'; } }
  function updateAiRuntime() { runtimeState.textContent = window.AgentChat.runtimeLabel(aiRuntime, translationAiScope()); }
  window.AgentChat.runtime().then((runtime) => { aiRuntime = runtime; updateAiRuntime(); });
  async function clearPendingAiMemory() {
    if (aiMemoryClearPromise) return aiMemoryClearPromise;
    aiMemoryClearPromise = (async () => {
      while (aiPendingMemoryClears.size) {
        const id = aiPendingMemoryClears.values().next().value;
        const cleared = await window.AgentChat.clearConversation({ url: `/api/exams/${encodeURIComponent(paper)}/assistant`, conversationId: id, scope: 'question', questionId: question });
        if (!cleared) throw new Error('旧服务端记忆暂未确认删除。');
        aiPendingMemoryClears.delete(id); saveAiConversations();
      }
    })();
    try { await aiMemoryClearPromise; } finally { aiMemoryClearPromise = null; }
  }

  function notify(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function textValue(value, max) {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('内容长度或文字格式无效。');
    return value;
  }
  function readStored(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (_error) {
      throw new Error('本机资料无法读取。为保护已有内容，已停止覆盖写入；请保留当前输入并检查浏览器存储。');
    }
  }
  function writeStored(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_error) { throw new Error('保存失败：浏览器存储空间不足或禁止写入。当前输入没有清空，原有资料未被覆盖。'); }
  }
  function validMethod(value) {
    if (!value || typeof value.updatedAt !== 'string') throw new Error('本机方法数据格式无效，已停止覆盖写入。');
    textValue(value.source, MAX_METHOD_CHARS);
    return { source: value.source, updatedAt: value.updatedAt };
  }
  function readMethod() { const value = readStored(METHOD_KEY); return value === undefined ? null : validMethod(value); }
  function validMethodRefs(value = []) {
    if (!Array.isArray(value) || value.length > 32) throw new Error('已有笔记的方法关联格式无效，已停止覆盖写入。');
    const result = value.map((ref) => {
      if (!ref || !['github', 'personal'].includes(ref.source) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 160 || /[\0\r\n]/.test(ref.id) || typeof ref.title !== 'string' || !ref.title.trim() || ref.title.length > 160) throw new Error('已有笔记的方法关联格式无效，已停止覆盖写入。');
      return { source: ref.source, id: ref.id, title: textValue(ref.title, 160) };
    });
    if (new Set(result.map((ref) => `${ref.source}:${ref.id}`)).size !== result.length) throw new Error('已有笔记的方法关联存在冲突，已停止覆盖写入。');
    return result;
  }
  function validNote(value) {
    if (!value || typeof value.contextKey !== 'string' || typeof value.paper !== 'string' || typeof value.question !== 'string' || typeof value.updatedAt !== 'string' || !(value.page === null || Number.isInteger(value.page) && value.page >= 1 && value.page <= 999)) throw new Error('已有笔记格式无效，已停止覆盖写入。');
    if (value.paper && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.paper)) throw new Error('已有笔记标识无效，已停止覆盖写入。');
    if (value.question && !/^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/.test(value.question)) throw new Error('已有笔记题号无效，已停止覆盖写入。');
    const expected = value.paper ? `${value.paper}:${value.question ? `question:${value.question}` : `page:${value.page || 1}`}` : 'personal';
    if (value.contextKey !== expected) throw new Error('已有笔记定位信息无效，已停止覆盖写入。');
    const result = { ...value, contextKey: value.contextKey, paper: value.paper, question: value.question, page: value.page, updatedAt: value.updatedAt };
    Object.keys(fields).forEach((field) => { result[field] = textValue(value[field], MAX_FIELD_CHARS); });
    result.methodRefs = validMethodRefs(value.methodRefs);
    return result;
  }
  function validNotes(value) {
    if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error('已有笔记库格式无效，已停止覆盖写入。');
    const result = value.map(validNote);
    if (new Set(result.map((note) => note.contextKey)).size !== result.length) throw new Error('已有笔记库包含冲突记录，已停止覆盖写入。');
    return result;
  }
  function readNotes() { const value = readStored(NOTES_KEY); return value === undefined ? [] : validNotes(value); }
  function snapshotNote() {
    const note = { contextKey, paper, question, page, methodRefs: validMethodRefs(methodRefs), updatedAt: new Date().toISOString() };
    Object.entries(fields).forEach(([field, input]) => { note[field] = textValue(input.value, MAX_FIELD_CHARS); });
    return note;
  }
  function validDrafts(value) {
    if (!value || value.version !== 1 || !(value.method === null || typeof value.method === 'object')) throw new Error('草稿数据格式无效，已停止自动覆盖。');
    return { version: 1, method: value.method === null ? null : validMethod(value.method), notes: validNotes(value.notes) };
  }
  function writeDrafts({ clearMethod = false, clearNote = false } = {}) {
    if (!draftsWritable) throw new Error('草稿资料暂时无法读取，为保护原有草稿已停止自动写入。当前输入仍保留，请先保存正式资料。');
    // Merge only this context's edits into the freshest data so another open
    // question cannot have its independent draft overwritten by a stale tab.
    const stored = readStored(DRAFTS_KEY);
    const latest = stored === undefined ? { version: 1, method: null, notes: [] } : validDrafts(stored);
    if (clearMethod) latest.method = null;
    else if (methodDirty) latest.method = { source: textValue(methodInput.value, MAX_METHOD_CHARS), updatedAt: new Date().toISOString() };
    if (clearNote) latest.notes = latest.notes.filter((item) => item.contextKey !== contextKey);
    else if (noteDirty) {
      const note = snapshotNote();
      const index = latest.notes.findIndex((item) => item.contextKey === contextKey);
      if (index >= 0) latest.notes[index] = { ...latest.notes[index], ...note };
      else {
        if (latest.notes.length >= MAX_RECORDS) throw new Error('本机草稿已达 200 份，请先保存当前笔记。当前输入没有清空。');
        latest.notes.push(note);
      }
    }
    writeStored(DRAFTS_KEY, latest);
    drafts = latest;
  }
  function flushDrafts() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (!methodDirty && !noteDirty) return true;
    try {
      writeDrafts();
      if (methodDirty) methodState.textContent = '编辑草稿已保留';
      if (noteDirty) noteState.textContent = '编辑草稿已保留';
      return true;
    } catch (error) { notify(error.message, true); return false; }
  }
  function scheduleDrafts(kind) {
    if (kind === 'method') { methodDirty = true; methodState.textContent = '方法尚未保存'; }
    else { noteDirty = true; noteState.textContent = '笔记尚未保存'; }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDrafts, 180);
  }
  function populateNote(note) { Object.entries(fields).forEach(([field, input]) => { input.value = note[field]; }); methodRefs = validMethodRefs(note.methodRefs); }
  function renderMethodRefs() {
    const container = document.getElementById('translation-bound-methods');
    container.replaceChildren();
    methodRefs.forEach((ref) => {
      const chip = document.createElement('span');
      chip.textContent = `${ref.source === 'github' ? '学习资料' : '我的方法'} · ${ref.title}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `解除方法关联：${ref.title}`);
      remove.addEventListener('click', () => { methodRefs = methodRefs.filter((item) => !(item.source === ref.source && item.id === ref.id)); renderMethodRefs(); scheduleDrafts('note'); window.dispatchEvent(new Event('translation-notes-changed')); });
      chip.append(remove); container.append(chip);
    });
  }

  function originalParagraph(text) {
    if (typeof text !== 'string' || text.includes('\0')) return '';
    // Some PDF extractors flatten the footer into the final sentence. Only
    // remove the unambiguous sentence-end + page number + URL combination;
    // dates, quantities and URLs within the actual paragraph remain intact.
    const cleaned = text.slice(0, MAX_FIELD_CHARS).replace(/\r\n?/g, '\n')
      .replace(/([。！？.!?])\s+\d{1,3}\s+(?:https?:\/\/|www\.)\S+\s*$/, '$1');
    const lines = cleaned.split('\n').filter((line) => (
      !/^\s*(?:请将|请把|将下列|把下列|将下面|把下面|翻译下列|翻译下面|要求[:：]|说明[:：])/.test(line)
      && !/^\s*(?:(?:\d{1,3}\s+)?(?:https?:\/\/\S+|www\.\S+)|\d{1,3}|第\s*\d+\s*页)\s*$/.test(line)
    ));
    const content = lines.join('\n');
    const start = content.search(/[\u3400-\u4dbf\u4e00-\u9fff]/);
    if (start < 0) return '';
    const result = content.slice(start).trim();
    return (result.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length >= 8 ? result : '';
  }

  function originalFromWords(pageData, targetQuestion = null) {
    const words = Array.isArray(pageData?.words) ? pageData.words.filter((word) => (
      word && typeof word.text === 'string' && Number.isFinite(Number(word.x)) && Number.isFinite(Number(word.y))
    )) : [];
    const lines = new Map();
    words.forEach((word) => {
      const key = word.line !== undefined && word.line !== null ? String(word.line) : `y:${Math.round(Number(word.y) / 3)}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(word);
    });
    const rows = [...lines.values()].map((line) => ({
      y: Math.min(...line.map((word) => Number(word.y))),
      text: line.sort((a, b) => Number(a.x) - Number(b.x)).map((word) => word.text).join(' ')
        .replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '$1'),
    })).sort((a, b) => a.y - b.y);
    const bbox = targetQuestion?.bbox;
    if (bbox && Number.isFinite(Number(bbox.y)) && Number(bbox.height) > 0) {
      return originalParagraph(rows.filter((row) => row.y >= Number(bbox.y) - 2 && row.y < Number(bbox.y) + Number(bbox.height)).map((row) => row.text).join('\n'));
    }
    const headings = rows.filter((row) => /^(?:(?:part|section)\s*[ivx\d]+\s*[-:.)]?\s*)?(?:translation|翻译)(?:\s*[\[(（]\s*\d{1,3}\s*(?:minutes?|mins?|分钟)\s*[\])）])?\s*$/i.test(row.text.trim()));
    if (headings.length !== 1) return '';
    const start = headings[0].y;
    const end = rows.find((row) => row.y > start && /^(?:part|section)\s+[ivx\d]+\b/i.test(row.text))?.y ?? Infinity;
    return originalParagraph(rows.filter((row) => row.y > start && row.y < end).map((row) => row.text).join('\n'));
  }

  async function loadOriginal(force = false) {
    const originalState = document.getElementById('translation-original-state');
    const loadButton = document.getElementById('load-translation-original');
    if (!paper || !originalState || !loadButton) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    loadButton.disabled = true;
    originalState.textContent = '正在从当前试卷读取原文…';
    try {
      const getJson = async (suffix) => {
        const response = await fetch(`/api/exams/${encodeURIComponent(paper)}/${suffix}`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        return response.json();
      };
      const [questionResult, manifestResult] = await Promise.allSettled([getJson('questions'), getJson('manifest')]);
      const questionData = questionResult.status === 'fulfilled' ? questionResult.value : null;
      const manifest = manifestResult.status === 'fulfilled' ? manifestResult.value : null;
      const candidates = Array.isArray(questionData) ? questionData : questionData?.questions ?? questionData?.data?.questions ?? [];
      const current = question && Array.isArray(candidates) ? candidates.find((item) => String(item?.questionId ?? item?.id ?? '') === question && item?.type === 'translation') : null;
      verifiedQuestion = current;
      verifiedRevision = Number.isInteger(questionData?.revision) ? questionData.revision : null;
      updateApplyAvailability();
      if (question && !current) {
        originalState.textContent = '未找到与当前题号绑定的翻译原文，可以手动填写；不会读取其他题目的作答。';
        return;
      }
      const currentPage = current ? Number(current.page) : page;
      const pageData = Array.isArray(manifest?.pages) ? manifest.pages.find((item) => Number(item.number ?? item.page) === currentPage) : null;
      const original = originalParagraph(current?.stem ?? current?.prompt ?? current?.text ?? '') || originalFromWords(pageData, current);
      if (!original) {
        originalState.textContent = '没有提取到可确认的中文原文，可以手动填写；英文 Directions 不会当作原文。';
        return;
      }
      loadButton.disabled = false;
      if (typeof manifest?.title === 'string') {
        document.getElementById('translation-context').textContent = `${manifest.title.slice(0, 160)} · 翻译练习${currentPage ? ` · 第 ${currentPage} 页` : ''}。笔记与试卷作答分开保存。`;
      }
      if (force) {
        if (fields.original.value.trim() && fields.original.value !== original && !window.confirm('当前原句已有内容，确定用试卷原文替换吗？其他笔记字段不会改变。')) {
          originalState.textContent = '已保留你当前的原句。';
          return;
        }
        fields.original.value = original;
        scheduleDrafts('note');
        originalState.textContent = '已重新载入试卷原文，请对照原卷检查。其他笔记和作答未改动。';
        return;
      }
      const canPrefill = !noteRestored && !noteDirty;
      let prefilled = false;
      if (canPrefill && !fields.original.value.trim()) { fields.original.value = original; prefilled = true; }
      if (canPrefill && current && !fields.firstDraft.value.trim()) {
        try {
          const readerState = readStored(`exam-viewer:${paper}:v1`);
          const answer = readerState?.answers?.[question];
          if (typeof answer === 'string' && answer.trim() && answer.length <= MAX_FIELD_CHARS && !answer.includes('\0')) {
            fields.firstDraft.value = answer;
            prefilled = true;
          }
        } catch (_error) { /* A broken reader record cannot overwrite this notebook. */ }
      }
      if (prefilled) scheduleDrafts('note');
      originalState.textContent = prefilled ? '已带入当前题原文及已有作答（如有），请对照原卷检查。笔记不会自动覆盖考试答案。'
        : '已找到当前题原文；你的已有笔记或草稿保持不变，需要时可点击“重新载入原题”。';
    } catch (_error) { originalState.textContent = '原文暂时无法读取，可以手动填写，已有输入不会改变。'; }
    finally { clearTimeout(timer); }
  }
  function saveMethod() {
    try {
      readMethod(); // Validate the existing value before replacing it.
      const source = textValue(methodInput.value, MAX_METHOD_CHARS);
      if (!source.trim()) throw new Error('请先放入自己的翻译方法，再点击保存。');
      writeStored(METHOD_KEY, { source, updatedAt: new Date().toISOString() });
      methodDirty = false;
      drafts.method = null;
      methodState.textContent = '方法已保存到本机';
      try { writeDrafts({ clearMethod: true }); }
      catch (error) { notify(`本机方法已写入，但草稿缓存更新失败。${error.message}`, true); return; }
      notify('个人翻译方法已保存到当前浏览器。它是你提供的学习资料，不是官方解析。');
    } catch (error) { notify(error.message, true); }
  }
  function saveNote() {
    try {
      const notes = readNotes();
      const note = snapshotNote();
      if (!Object.keys(fields).some((field) => note[field].trim())) throw new Error('至少填写一个字段即可保存，也可以只写自由笔记。');
      const index = notes.findIndex((item) => item.contextKey === contextKey);
      const latestBaseline = index >= 0 ? JSON.stringify(notes[index]) : null;
      if (latestBaseline !== savedNoteBaseline) throw new Error('这份正式笔记已在另一个窗口修改。当前输入保留，未覆盖新记录；请先备份当前草稿，再重新打开核对。');
      if (index >= 0) notes[index] = { ...notes[index], ...note };
      else {
        if (notes.length >= MAX_RECORDS) throw new Error('本机翻译笔记已达 200 份，当前输入仍保留，请先备份和整理已有笔记。');
        notes.push(note);
      }
      writeStored(NOTES_KEY, notes);
      savedNoteBaseline = JSON.stringify(notes.find((item) => item.contextKey === contextKey));
      noteDirty = false;
      drafts.notes = drafts.notes.filter((item) => item.contextKey !== contextKey);
      noteState.textContent = '这份笔记已保存';
      try { writeDrafts({ clearNote: true }); }
      catch (error) { notify(`这份笔记已写入，但草稿缓存更新失败。${error.message}`, true); return; }
      notify('这份翻译笔记已保存到当前浏览器，其他题目或页面的记录没有被覆盖。');
      window.dispatchEvent(new Event('translation-notes-changed'));
    } catch (error) { notify(error.message, true); }
  }
  async function importMethod(file) {
    const input = document.getElementById('translation-method-file');
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('请选择 TXT 或 MD 文件。');
      if (file.size > 64 * 1024) throw new Error('文件不能超过 64 KB，请缩小内容后导入。');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (source.includes('\0')) throw new Error('文件含有 NUL 字符，请使用纯文本 UTF-8 TXT / MD。原有输入未被更改。');
      if (source.length > MAX_METHOD_CHARS) throw new Error('方法正文最多 24,000 字符，请缩小内容后导入。原有输入未被更改。');
      if (!source.trim()) throw new Error('文件没有正文，请选择包含翻译方法的文本文件。');
      methodInput.value = source;
      scheduleDrafts('method');
      notify(`已将“${file.name}”导入编辑草稿，尚未覆盖已保存的方法。请检查内容后点击“保存本机方法”。`);
    } catch (error) { notify(error instanceof TypeError ? '文件不是有效的 UTF-8 文本，原有输入未被更改。' : error.message, true); }
    finally { input.value = ''; }
  }

  function chosenAnswer() {
    const selected = document.getElementById('translation-answer-source').value;
    return selected === 'firstDraft' ? fields.firstDraft.value.trim() : fields.revised.value.trim() || fields.firstDraft.value.trim();
  }
  function updateApplyAvailability() {
    const available = !!(paper && verifiedQuestion && window.LearningStore && question);
    document.getElementById('apply-translation-answer').disabled = !available;
    document.getElementById('translation-mobile-apply').disabled = !available;
    document.getElementById('translation-apply-state').textContent = available
      ? '只应用到当前已确认的翻译题。修改稿为空时使用初译；应用前会展示成稿。'
      : '未绑定可确认的翻译题，不能写入试卷答案；你仍可保存独立笔记。';
  }
  function openAnswerPreview() {
    if (!verifiedQuestion || !paper || !question || !window.LearningStore) return;
    try {
      const answer = textValue(chosenAnswer(), MAX_FIELD_CHARS);
      if (!answer) throw new Error('请先写下初译或修改后的译文，再应用到本题。');
      const current = window.LearningStore.readExam(paper);
      const expectedAnswer = current.answers?.[question] || '';
      pendingAnswer = { answer, expectedAnswer };
      document.getElementById('translation-answer-preview-context').textContent = `当前试卷 · ${question}。笔记字段与其他题目的答案不会被替换。`;
      document.getElementById('translation-answer-preview-text').textContent = answer;
      document.getElementById('translation-existing-answer-text').textContent = expectedAnswer;
      const replacing = !!expectedAnswer && expectedAnswer !== answer;
      document.getElementById('translation-existing-answer').hidden = !expectedAnswer;
      document.getElementById('translation-overwrite-label').hidden = !replacing;
      document.getElementById('translation-overwrite-confirm').checked = false;
      document.getElementById('confirm-translation-answer').disabled = replacing;
      document.getElementById('translation-answer-preview-state').textContent = replacing ? '当前题已有答案，请确认覆盖后再应用。' : '确认后保存本题译文并返回原题。';
      document.getElementById('translation-answer-preview').showModal();
    } catch (error) { notify(error.message, true); }
  }
  async function applyAnswerAndReturn() {
    if (!pendingAnswer || !verifiedQuestion) return;
    const button = document.getElementById('confirm-translation-answer');
    button.disabled = true;
    const state = document.getElementById('translation-answer-preview-state');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      state.textContent = '正在确认题目并保存…';
      // A review revision may have removed/retyped this ID while the learner
      // was editing. Recheck it rather than creating a guessed answer key.
      const response = await fetch(`/api/exams/${encodeURIComponent(paper)}/questions`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('暂时无法确认当前题目，未写入答案。请稍后重试。');
      const documentData = await response.json();
      const items = Array.isArray(documentData) ? documentData : documentData?.questions ?? documentData?.data?.questions;
      if (!Array.isArray(items) || !items.some((item) => String(item?.questionId ?? item?.id ?? '') === question && item?.type === 'translation')) throw new Error('当前题号已变更或不再是翻译题，未写入答案。请从试卷重新进入。');
      if (Number.isInteger(verifiedRevision) && Number.isInteger(documentData?.revision) && verifiedRevision !== documentData.revision) throw new Error('试卷题目已更新，未写入答案。请返回试卷核对题目后再进入。');
      if (chosenAnswer() !== pendingAnswer.answer) throw new Error('确认期间译文已发生变化，未写入答案。请重新预览后再应用。');
      if (!flushDrafts()) throw new Error('笔记草稿未能保存，已暂停应用。当前输入保留，请先处理存储问题。');
      window.LearningStore.applyAnswer({ paper, question, answer: pendingAnswer.answer, expectedAnswer: pendingAnswer.expectedAnswer });
      state.textContent = '本题译文已保存，正在返回试卷。';
      location.assign(document.getElementById('back-to-reader').href);
    } catch (error) {
      state.textContent = error.name === 'AbortError' ? '确认题目超时，未写入答案。当前输入保留，可以重试。' : error.message;
      notify(state.textContent, true);
      button.disabled = false;
    } finally { clearTimeout(timer); }
  }
  function setWorkspaceView(view) {
    if (!['practice', 'methods', 'resources'].includes(view)) return;
    document.body.dataset.translationView = view;
    document.querySelectorAll('[data-translation-view]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.translationView === view)));
  }
  function safeAiReply(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (/^(?:```(?:json)?\s*)?\{/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        return typeof parsed.reply === 'string' ? parsed.reply.slice(0, 16000) : '';
      } catch (_error) { return ''; }
    }
    return trimmed.slice(0, 16000);
  }
  async function askLearningAi(mode = aiMode) {
    if (aiBusy || aiResetBusy) return;
    const input = document.getElementById('translation-ai-input');
    const state = document.getElementById('translation-ai-state');
    const reply = document.getElementById('translation-ai-reply');
    if (aiPendingMemoryClears.size >= 40) { state.textContent = '待清除的旧会话已达到上限，请点击“新建对话”重试删除后再请求 AI；笔记仍可编辑。'; return; }
    if (!paper) { state.textContent = '请从上传试卷的翻译题进入后再请求 AI。当前个人笔记不会发送。'; return; }
    const original = fields.original.value.trim();
    const answer = chosenAnswer();
    if (!original && !answer) { state.textContent = '请先填写原文或译文，再请求辅导。'; return; }
    const prompts = { hint: '只提示下一步，不直接给完整译文。', review: '检查当前译文，说明具体问题和修改理由，不代替我保存答案。', method: '按选中的学习方法分析当前句子；不适用时明确说明，不强行套用。' };
    aiMode = ['hint', 'review', 'method'].includes(mode) ? mode : 'hint';
    const consent = document.getElementById('translation-ai-consent').checked;
    const consentEpochAtSend = aiConsentEpoch;
    const selectedMethod = window.TranslationMethodSelection;
    if (aiMode === 'method' && selectedMethod?.source === 'personal' && !consent) {
      state.textContent = '当前选中的是个人方法。请勾选“本次允许检索我保存的翻译笔记及个人方法”后再按该方法分析；本次没有发送请求。';
      return;
    }
    const publicIds = methodRefs.filter((ref) => ref.source === 'github').map((ref) => ref.id);
    if (selectedMethod?.source === 'github') publicIds.unshift(selectedMethod.id);
    const learningContext = { mode: aiMode, methodIds: [...new Set(publicIds)].slice(0, 8), consentPersonal: consent };
    let personalFragmentNotice = '';
    try {
      if (consent) {
        const selectedPersonal = selectedMethod?.source === 'personal';
        const personalSource = selectedPersonal
          ? `${textValue(selectedMethod.title, 160)}\n\n${textValue(selectedMethod.bodyMarkdown || '', MAX_METHOD_CHARS)}`
          : textValue(methodInput.value, MAX_METHOD_CHARS);
        learningContext.personalMethods = personalSource.slice(0, 3000);
        if (selectedPersonal) personalFragmentNotice = personalSource.length > 3000
          ? `本次使用你选定的“${selectedMethod.title}”，仅发送该方法前 3,000 字符，后续内容未发送。`
          : `本次使用你选定的个人方法“${selectedMethod.title}”。`;
        else if (personalSource.length > 3000) personalFragmentNotice = '个人资料较长，本次仅发送编辑器前 3,000 字符，后续内容未发送。';
        const boundIds = new Set(methodRefs.map((ref) => `${ref.source}:${ref.id}`));
        if (selectedMethod?.source && selectedMethod?.id) boundIds.add(`${selectedMethod.source}:${selectedMethod.id}`);
        learningContext.notes = readNotes().sort((a, b) => {
          const relevance = (note) => note.methodRefs.some((ref) => boundIds.has(`${ref.source}:${ref.id}`)) ? 1 : 0;
          return relevance(b) - relevance(a) || b.updatedAt.localeCompare(a.updatedAt);
        }).slice(0, 3).map((note) => ({
          id: note.contextKey, original: note.original.slice(0, 500), firstDraft: note.firstDraft.slice(0, 500), revised: note.revised.slice(0, 500), reason: note.reason.slice(0, 400), method: note.method.slice(0, 200), methodRefs: note.methodRefs.slice(0, 4).map(({ source, id }) => ({ source, id })),
        }));
      }
    } catch (error) { state.textContent = error.message; return; }
    const scope = verifiedQuestion && question ? 'question' : 'selection';
    const currentText = `${original ? `当前原文：\n${original.slice(0, 3000)}` : ''}${answer ? `\n\n当前译文：\n${answer.slice(0, 3000)}` : ''}`.trim();
    const selectedPersonalInstruction = consent && aiMode === 'method' && selectedMethod?.source === 'personal'
      ? `\n本次选定的是个人方法“${selectedMethod.title}”，请优先依据本次授权附带的这一方法分析；不适用时说明原因。` : '';
    const message = `${prompts[aiMode]}${selectedPersonalInstruction}${input.value.trim() ? `\n补充要求：${input.value.trim()}` : ''}`;
    if (message.length > 2000) { state.textContent = '补充问题过长，请缩短到 2,000 字符以内再发送。当前输入保留。'; return; }
    const conversationKey = scope === 'question' ? `question:${question}` : 'selection';
    const body = { scope, message, history: aiHistory.slice(-8), learningContext, requestId: `translation-${Date.now()}`, conversationId: aiConversations[conversationKey] = window.AgentChat.conversationId(aiConversations[conversationKey]) };
    if (consent && scope === 'question' && aiRuntime?.memory !== false && aiRuntime?.configured !== false) aiRequestAuthorizedId = body.conversationId;
    saveAiConversations(); updateAiRuntime();
    if (scope === 'question') { body.questionId = question; body.userAnswer = answer; if (Number.isInteger(verifiedRevision)) body.reviewRevision = verifiedRevision; }
    else body.selectedText = currentText.slice(0, 8000);
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).byteLength > 48 * 1024) { state.textContent = '当前学习资料过长，请缩短个人资料或取消本次检索个人笔记后再发送。'; return; }
    aiBusy = true;
    aiStopped = false;
    aiStopButton.hidden = false; aiStopButton.disabled = false; aiNewButton.disabled = true;
    document.querySelectorAll('[data-translation-ai], #send-translation-ai').forEach((button) => { button.disabled = true; });
    state.textContent = `请求已发送，等待服务返回进度与结果…${personalFragmentNotice ? ` ${personalFragmentNotice}` : ''}`;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
    aiController = controller;
    let partial = '';
    try {
      const data = await window.AgentChat.request({ url: `/api/exams/${encodeURIComponent(paper)}/assistant`, body: encoded, signal: controller.signal,
        onProgress: (event) => { state.textContent = window.AgentChat.progressLabel(event) || '等待服务返回完整结果…'; },
        onDelta: (text) => { partial += text; reply.textContent = /^[\s`]*(?:json\s*)?[{\[]/i.test(partial) ? '正在接收结构化响应，等待完整结果…' : partial; reply.dataset.partial = 'true'; },
      });
      if (consentEpochAtSend !== aiConsentEpoch) throw new Error('授权上下文已变更，旧请求的结果不会显示或进入后续对话。');
      if (data?.scope && data.scope !== scope || scope === 'question' && data?.questionId && data.questionId !== question) throw new Error('AI 返回的题目上下文不匹配，未显示分析。');
      if (data?.generation && !data.generation.used) throw new Error(data.generation.fallbackReason === 'not_configured' ? '尚未配置 AI 服务，请完成服务器配置后重试。' : 'AI 服务暂不可用，请稍后重试。');
      let content = safeAiReply(data?.reply);
      if (!content) throw new Error('AI 回答格式无法读取，当前输入保留，请重试。');
      const disclaimer = typeof data?.grounding?.disclaimer === 'string' ? data.grounding.disclaimer : '';
      if (disclaimer && !content.includes(disclaimer)) content = `${disclaimer}\n\n${content}`;
      if (typeof window.TranslationMethodMarkdown === 'function') reply.replaceChildren(window.TranslationMethodMarkdown(content));
      else reply.textContent = content;
      delete reply.dataset.partial;
      const citations = document.getElementById('translation-ai-citations'); citations.replaceChildren();
      (Array.isArray(data.learningCitations) ? data.learningCitations : []).slice(0, 12).forEach((citation) => {
        if (!citation || typeof citation.title !== 'string') return;
        const label = citation.kind === 'personal_note' ? '我的学习笔记' : citation.kind === 'personal_method' ? '我的方法' : '学习方法资料';
        const item = document.createElement('li'); item.textContent = `${label}（非官方解析）：${citation.title.slice(0, 160)}`; citations.append(item);
      });
      const oldExecution = document.getElementById('translation-ai-execution'); oldExecution?.remove();
      if (data.agent || data.generation) {
        const details = document.createElement('details'); details.id = 'translation-ai-execution';
        const summary = document.createElement('summary'); summary.textContent = data.agent ? '本次 Agent 执行记录' : '本次模型调用记录'; details.append(summary);
        const list = document.createElement('ul'); const add = (text) => { const item = document.createElement('li'); item.textContent = text; list.append(item); };
        if (data.agent?.trace?.durationMs !== undefined && Number.isFinite(data.agent.trace.durationMs)) add(`耗时：${Math.max(0, Math.round(data.agent.trace.durationMs))} ms`);
        const execution = window.AgentChat.normalizeExecution(data.agent?.execution);
        if (execution?.rounds !== null && execution) add(`工具决策轮数：${execution.rounds}`);
        if (execution?.toolCalls !== null && execution) add(`实际工具调用次数：${execution.toolCalls}`);
        (Array.isArray(data.agent?.tools) ? data.agent.tools : []).slice(0, 12).forEach((tool) => { const name = typeof tool === 'string' ? tool : typeof tool?.name === 'string' ? tool.name : ''; if (name) add(`工具：${name.slice(0, 80)}${typeof tool?.status === 'string' ? `（${tool.status.slice(0, 40)}）` : ''}`); });
        const usage = data.generation?.usage;
        if (usage && Number.isInteger(usage.totalTokens)) add(`模型 Tokens：${usage.totalTokens}`);
        if (data.generation) add(data.generation.used ? `已使用模型：${String(data.generation.model || 'DeepSeek').slice(0, 160)}` : '本次未调用模型');
        if (data.agent?.memory?.enabled === true) add('本题会话记忆已启用；新建对话可清除该会话记忆。');
        details.append(list); citations.after(details);
      }
      state.textContent = data?.grounding?.officialExplanationFound === true
        ? '包含答案资料解析；学习方法和个人笔记仍为非官方资料。当前答案和笔记未被修改。'
        : 'AI 辅助建议，仅供对照。当前答案和笔记未被修改。';
      if (personalFragmentNotice) state.textContent += ` ${personalFragmentNotice}`;
      if (aiPendingMemoryClears.size) state.textContent += ' 旧服务端摘要未删除，旧内容不会用于新请求；可点“新建对话”重试删除。';
      if (consentEpochAtSend !== aiConsentEpoch) state.textContent += ' 本次已发出的请求无法撤回；后续提问不会沿用本次对话资料。';
      if (consentEpochAtSend === aiConsentEpoch) {
        aiHistory.push({ role: 'user', content: message.slice(0, 2000) }, { role: 'assistant', content: content.slice(0, 2000) });
        aiHistory = aiHistory.slice(-8);
      } else aiHistory = [];
    } catch (error) {
      state.textContent = aiStopped ? '已停止生成。未完成回复仅临时展示，不计入对话；当前输入保留。已发出的模型请求可能仍产生费用。' : error.name === 'AbortError' ? 'AI 请求超时，当前输入保留，可以重试。' : error.revisionChanged ? '试卷题目已更新，请返回原题确认后再提问。' : error instanceof TypeError ? '无法连接本地服务，请确认服务正在运行；当前输入保留。' : error.serverDetail && !/[{}<>\n]/.test(error.serverDetail) ? error.serverDetail : error.message;
      if (partial) state.textContent += ' 此次回复未完成，没有写入对话历史。';
      if (consentEpochAtSend !== aiConsentEpoch && aiWithdrawalNotice) state.textContent += ` ${aiWithdrawalNotice}`;
    }
    finally { clearTimeout(timer); aiBusy = false; aiController = null; aiStopButton.hidden = true; aiNewButton.disabled = false; document.querySelectorAll('[data-translation-ai], #send-translation-ai').forEach((button) => { button.disabled = false; }); }
  }

  if (paper) {
    const back = document.getElementById('back-to-reader');
    const returnParams = new URLSearchParams({ paper, cachefix: '20261008-learning-loop-1' });
    if (question) returnParams.set('question', question);
    if (page) returnParams.set('page', String(page));
    back.href = `reader.html?${returnParams}`;
    document.getElementById('open-writing-library').href = `writing.html?${returnParams}`;
    back.textContent = question ? '返回当前题目' : '返回当前试卷页';
    back.hidden = false;
    document.getElementById('translation-mobile-back').href = back.href;
    const questionLabel = question.startsWith('translation-') ? `翻译第 ${question.slice(12)} 题`
      : question.startsWith('writing-') ? `写作第 ${question.slice(8)} 题`
      : question ? `第 ${question.slice(1)} 题` : '';
    document.getElementById('translation-context').textContent = `来自当前试卷${questionLabel ? ` · ${questionLabel}` : ''}${page ? ` · 第 ${page} 页` : ''}。这份笔记只绑定${question ? '这道题' : `第 ${page || 1} 页`}。`;
  }
  let loadError = false;
  try { const saved = readMethod(); if (saved) { methodInput.value = saved.source; methodState.textContent = '本机方法已载入'; } }
  catch (error) { loadError = true; notify(error.message, true); }
  try { const saved = readNotes().find((note) => note.contextKey === contextKey); if (saved) { populateNote(saved); savedNoteBaseline = JSON.stringify(saved); noteRestored = true; noteState.textContent = '已载入这份笔记'; } }
  catch (error) { loadError = true; notify(error.message, true); }
  try {
    const stored = readStored(DRAFTS_KEY);
    if (stored !== undefined) {
      drafts = validDrafts(stored);
      if (drafts.method) { methodInput.value = drafts.method.source; methodDirty = true; methodState.textContent = '已恢复方法草稿'; }
      const note = drafts.notes.find((item) => item.contextKey === contextKey);
      if (note) { populateNote(note); noteRestored = true; noteDirty = true; noteState.textContent = '已恢复笔记草稿'; }
      if (!loadError && (methodDirty || noteDirty)) notify('已恢复当前资料的编辑草稿，尚未覆盖正式保存的版本。');
    }
  } catch (error) { draftsWritable = false; notify(`${error.message} 当前页面中的输入仍保留。`, true); }
  methodInput.addEventListener('input', () => scheduleDrafts('method'));
  Object.values(fields).forEach((input) => input.addEventListener('input', () => scheduleDrafts('note')));
  [fields.firstDraft, fields.revised, fields.freeNote].forEach((input) => input.addEventListener('focus', () => { activeTarget = input; }));
  renderMethodRefs();
  window.TranslationNotebook = Object.freeze({ readNotes });
  setWorkspaceView('practice');
  document.querySelectorAll('[data-translation-view]').forEach((tab) => tab.addEventListener('click', () => setWorkspaceView(tab.dataset.translationView)));
  document.getElementById('translation-focus-toggle').addEventListener('click', (event) => {
    const focused = document.body.classList.toggle('translation-focus-mode');
    event.currentTarget.setAttribute('aria-pressed', String(focused));
    event.currentTarget.textContent = focused ? '退出专注编辑' : '专注编辑';
  });
  document.querySelector('.back-to-practice').addEventListener('click', () => setWorkspaceView('practice'));
  document.querySelector('.catalog-personal-link').addEventListener('click', () => setWorkspaceView('resources'));
  document.getElementById('translation-mobile-save').addEventListener('click', saveNote);
  document.getElementById('translation-mobile-apply').addEventListener('click', openAnswerPreview);
  document.getElementById('apply-translation-answer').addEventListener('click', openAnswerPreview);
  document.getElementById('cancel-translation-answer').addEventListener('click', () => document.getElementById('translation-answer-preview').close());
  document.getElementById('translation-overwrite-confirm').addEventListener('change', (event) => { document.getElementById('confirm-translation-answer').disabled = !event.target.checked; });
  document.getElementById('confirm-translation-answer').addEventListener('click', applyAnswerAndReturn);
  window.addEventListener('translation-method-bound', (event) => {
    try {
      const ref = validMethodRefs([event.detail])[0];
      if (!methodRefs.some((item) => item.source === ref.source && item.id === ref.id)) {
        if (methodRefs.length >= 32) throw new Error('本次笔记最多关联 32 项方法，请先整理已有记录。');
        methodRefs.push(ref); renderMethodRefs(); scheduleDrafts('note');
        window.dispatchEvent(new Event('translation-notes-changed'));
      }
    } catch (error) { notify(error.message, true); }
  });
  document.querySelectorAll('[data-translation-ai]').forEach((button) => button.addEventListener('click', () => askLearningAi(button.dataset.translationAi)));
  document.getElementById('send-translation-ai').addEventListener('click', () => askLearningAi());
  aiStopButton.addEventListener('click', () => { if (!aiBusy) return; aiStopped = true; aiStopButton.disabled = true; aiController?.abort(); });
  aiNewButton.addEventListener('click', async () => {
    if (aiBusy || aiResetBusy) return;
    aiResetBusy = true; aiNewButton.disabled = true; document.getElementById('send-translation-ai').disabled = true;
    const key = translationConversationKey(); const id = aiConversations[key];
    try {
      await clearPendingAiMemory();
      if (id) await window.AgentChat.clearConversation({ url: `/api/exams/${encodeURIComponent(paper)}/assistant`, conversationId: id, scope: translationAiScope(), questionId: question });
      aiConversations[key] = window.AgentChat.conversationId(); aiRequestAuthorizedId = ''; aiWithdrawalNotice = ''; saveAiConversations(); aiHistory = []; aiConsentEpoch += 1;
      document.getElementById('translation-ai-reply').replaceChildren(); document.getElementById('translation-ai-citations').replaceChildren(); document.getElementById('translation-ai-execution')?.remove();
      document.getElementById('translation-ai-state').textContent = '已开始新的对话；支持记忆的本题已先清除服务端会话记忆，答案和笔记不受影响。';
    } catch (_error) { document.getElementById('translation-ai-state').textContent = aiPendingMemoryClears.size ? '旧服务端摘要未删除，旧内容不会用于新请求；可点“新建对话”重试删除。当前笔记与输入仍保留。' : '服务端会话记忆未能清除，当前对话仍保留，请稍后重试。'; }
    finally { aiResetBusy = false; aiNewButton.disabled = false; document.getElementById('send-translation-ai').disabled = false; }
  });
  document.getElementById('translation-ai-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !aiComposing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); askLearningAi(); }
  });
  document.getElementById('translation-ai-input').addEventListener('compositionstart', () => { aiComposing = true; });
  document.getElementById('translation-ai-input').addEventListener('compositionend', () => { aiComposing = false; });
  document.getElementById('translation-ai-consent').addEventListener('change', async (event) => {
    // Replies grounded in personal notes must not enter a later unconsented
    // request via conversation history.
    aiHistory = [];
    aiConsentEpoch += 1;
    const epoch = aiConsentEpoch;
    const oldId = aiRequestAuthorizedId;
    const withdrawing = event.currentTarget.checked === false;
    if (withdrawing) {
      aiRequestAuthorizedId = '';
      if (oldId && translationAiScope() === 'question') aiPendingMemoryClears.add(oldId);
      if (aiBusy) { aiStopped = true; aiController?.abort(); }
      document.getElementById('translation-ai-reply').replaceChildren(); document.getElementById('translation-ai-citations').replaceChildren(); document.getElementById('translation-ai-execution')?.remove();
      aiWithdrawalNotice = oldId ? '已撤销个人资料授权；正在删除旧服务端会话记忆，后续请求不会沿用旧内容。' : '已撤销个人资料授权；后续请求不会沿用旧内容。';
    }
    aiConversations[translationConversationKey()] = window.AgentChat.conversationId();
    saveAiConversations();
    document.getElementById('translation-ai-state').textContent = withdrawing ? aiWithdrawalNotice : `已开始新的上下文；旧回复仍可查看，但不会发送给后续请求。${aiBusy ? ' 当前请求已经发出，无法撤回；新授权适用于下一次提问。' : ''}`;
    if (withdrawing && aiPendingMemoryClears.size) {
      try {
        await clearPendingAiMemory();
        aiWithdrawalNotice = '已撤销个人资料授权并删除旧服务端会话记忆；之后的请求不会沿用旧内容。';
      } catch (_error) {
        aiWithdrawalNotice = '已撤销个人资料授权，但旧服务端摘要未删除；旧内容不会用于新请求，可点“新建对话”重试删除。';
      }
      if (epoch === aiConsentEpoch) document.getElementById('translation-ai-state').textContent = aiWithdrawalNotice;
    }
  });
  if (window.LearningStore?.mountExpressions) window.LearningStore.mountExpressions({ container: document.getElementById('translation-expression-library'), getTarget: () => activeTarget, context: { paper, question, page, module: 'translation' } });
  updateApplyAvailability();
  document.getElementById('save-translation-method').addEventListener('click', saveMethod);
  document.getElementById('save-translation-note').addEventListener('click', saveNote);
  document.getElementById('translation-method-file').addEventListener('change', (event) => importMethod(event.target.files[0]));
  document.getElementById('load-translation-original')?.addEventListener('click', () => loadOriginal(true));
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute('download') || link.target && link.target !== '_self') return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin) return;
    if ((methodDirty || noteDirty) && !flushDrafts()) {
      event.preventDefault();
      notify(`${status.textContent} 请先保存资料，或保留当前页面再处理存储问题。`, true);
    }
  });
  window.addEventListener('pagehide', flushDrafts);
  window.addEventListener('beforeunload', (event) => {
    if ((methodDirty || noteDirty) && !flushDrafts()) { event.preventDefault(); event.returnValue = ''; }
  });
  loadOriginal();
})();
