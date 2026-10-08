(() => {
  'use strict';
  const PAPER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const QUESTION = /^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/;
  const EXPRESSION_KEY = 'cet:expression-library:v1';
  const categories = { intro: '开头', argument: '论据', suggestion: '建议', conclusion: '结尾', translation: '翻译表达', other: '其他' };
  const keys = new Set(['cet:writing-template-library:v1', 'cet:writing-template-draft:v1', 'cet:writing-answers:v1', 'cet:translation-method:v1', 'cet:translation-notes:v1', 'cet:translation-note-drafts:v1', EXPRESSION_KEY, 'cet:learning-review:v1']);
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function string(value, max = 12000) {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('资料格式或文字长度不正确；已有内容未被覆盖。');
    return value;
  }
  function boundedArray(value, max) {
    if (!Array.isArray(value) || value.length > max) throw new Error('资料条目数超过限制；已有内容未被覆盖。');
    return value;
  }
  function safeTree(value, depth = 0) {
    if (depth > 14) throw new Error('资料结构过深。');
    if (typeof value === 'string') return string(value, 100000);
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) { boundedArray(value, 2000).forEach((item) => safeTree(item, depth + 1)); return value; }
    if (!object(value) || Object.keys(value).length > 2000) throw new Error('资料结构无效。');
    Object.entries(value).forEach(([key, item]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('资料包含不安全字段。');
      string(key, 240); safeTree(item, depth + 1);
    });
    return value;
  }
  function context(value = {}) {
    const paper = value.paper || '';
    const question = value.question || '';
    const page = value.page === undefined || value.page === null ? null : value.page;
    if (paper && !PAPER.test(paper) || question && (!paper || !QUESTION.test(question)) || page !== null && (!Number.isInteger(page) || page < 1 || page > 999)) throw new Error('资料的试卷定位无效。');
    return { paper, question, page, module: string(value.module || '', 40) };
  }
  function read(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); }
    catch (_error) { throw new Error('本机资料无法读取，已停止覆盖写入。请先导出原始备份并保留当前输入。'); }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_error) { throw new Error('保存失败：浏览器存储不可用或空间不足。请保留当前输入并导出备份。'); }
    window.dispatchEvent(new CustomEvent('learning-store-changed', { detail: { key } }));
  }
  function examKey(paper) { if (!PAPER.test(paper)) throw new Error('试卷标识无效。'); return `exam-viewer:${paper}:v1`; }
  function validateExam(value) {
    if (!object(value)) throw new Error('试卷记录格式无效，已停止覆盖写入。');
    safeTree(value);
    if (value.answers !== undefined) {
      if (!object(value.answers) || Object.keys(value.answers).length > 300) throw new Error('试卷答案记录格式无效。');
      Object.entries(value.answers).forEach(([id, answer]) => { if (!QUESTION.test(id)) throw new Error('试卷答案题号无效。'); string(answer); });
    }
    if (value.annotations !== undefined) {
      boundedArray(value.annotations, 1000).forEach((item) => {
        if (!object(item) || !['tag', 'line', 'highlight'].includes(item.type) || !Number.isInteger(item.page) || item.page < 1 || item.page > 999) throw new Error('标注格式无效。');
        string(item.id, 160);
        if (item.quote !== undefined) string(item.quote, 1200);
        if (item.createdAt !== undefined && (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || Math.abs(item.createdAt) > 8640000000000000)) throw new Error('标注时间无效。');
        if (item.type === 'line') {
          ['x1', 'x2', 'y1', 'y2', 'width'].forEach((field) => { if (typeof item[field] !== 'number' || !Number.isFinite(item[field])) throw new Error('直线坐标无效。'); });
          if (item.width <= 0) throw new Error('直线宽度无效。');
        } else {
          const rects = boundedArray(item.rects, 80);
          if (!rects.length) throw new Error('标注缺少定位区域。');
          rects.forEach((rect) => { if (!object(rect) || !['x', 'y', 'width', 'height'].every((field) => typeof rect[field] === 'number' && Number.isFinite(rect[field])) || rect.width <= 0 || rect.height <= 0) throw new Error('标注坐标无效。'); });
        }
        if (item.type === 'tag') { string(item.note || '', 6000); string(item.label || '', 16); }
      });
    }
    return value;
  }
  function readExam(paper) { return validateExam(read(examKey(paper), {})); }
  function applyAnswer({ paper, question, answer, expectedAnswer }) {
    if (!QUESTION.test(question)) throw new Error('必须先确认本题题号，不能自动生成题号。');
    string(answer); string(expectedAnswer);
    if (!answer.trim() || /\{\{[^{}]*\}\}/.test(answer)) throw new Error('请先完成正文及全部填空，再应用到试卷。');
    const latest = readExam(paper);
    if ((latest.answers?.[question] || '') !== expectedAnswer) throw new Error('本题答案已在另一个窗口修改，请重新预览并确认，当前内容仍保留。');
    const merged = { ...latest, answers: { ...(latest.answers || {}), [question]: answer }, submitted: false, grade: null };
    write(examKey(paper), merged);
    return merged;
  }
  function validExpression(value) {
    if (!object(value) || !/^[A-Za-z0-9._-]{1,80}$/.test(value.id) || !Object.hasOwn(categories, value.category)) throw new Error('表达记录格式无效。');
    const tags = boundedArray(value.tags, 10).map((tag) => string(tag, 40));
    return { id: value.id, text: string(value.text, 2000), category: value.category, tags, example: string(value.example || '', 2000), source: string(value.source || '', 240), context: context(value.context), updatedAt: string(value.updatedAt || '', 80) };
  }
  function expressions() {
    const data = read(EXPRESSION_KEY, { version: 1, entries: [] });
    if (!object(data) || data.version !== 1) throw new Error('表达库格式无效，已停止覆盖写入。');
    const entries = boundedArray(data.entries, 500).map(validExpression);
    if (new Set(entries.map((item) => item.id)).size !== entries.length) throw new Error('表达库标识冲突。');
    return entries;
  }
  function saveExpression(value) {
    const entries = expressions();
    const record = validExpression({ ...value, id: value.id || `expression-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, updatedAt: new Date().toISOString() });
    if (!record.text.trim()) throw new Error('先选中或填写要收藏的表达。');
    const index = entries.findIndex((item) => item.id === record.id);
    if (value.id && typeof value.updatedAt === 'string' && (index === -1 || entries[index].updatedAt !== value.updatedAt)) throw new Error('这条表达已在另一窗口修改或删除，请重新打开再编辑。当前输入没有清空。');
    if (index === -1 && entries.length >= 500) throw new Error('表达库已达 500 条，请先备份整理。');
    if (index === -1) entries.unshift(record); else entries[index] = record;
    write(EXPRESSION_KEY, { version: 1, entries });
    return record;
  }
  function removeExpression(id) { write(EXPRESSION_KEY, { version: 1, entries: expressions().filter((item) => item.id !== id) }); }
  function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
  function readerLink(value) {
    const ctx = context(value);
    if (!ctx.paper) return null;
    const params = new URLSearchParams({ paper: ctx.paper });
    if (ctx.question) params.set('question', ctx.question);
    if (ctx.page) params.set('page', ctx.page);
    if (value.noteId && typeof value.noteId === 'string' && value.noteId.length <= 160) params.set('note', value.noteId);
    return `reader.html?${params}`;
  }
  function expressionEditor(host, initial, onSave) {
    const label = (text, control) => { const field = node('label', text, 'learning-field'); field.append(control); return field; };
    const text = node('textarea'); text.rows = 3; text.maxLength = 2000; text.value = initial.text || ''; text.dataset.expressionText = '';
    const category = node('select'); Object.entries(categories).forEach(([id, title]) => { const option = node('option', title); option.value = id; category.append(option); }); category.value = initial.category || 'other';
    const tags = node('input'); tags.maxLength = 409; tags.placeholder = '用逗号分隔，例如：建议, 环保'; tags.value = (initial.tags || []).join(', ');
    const source = node('input'); source.maxLength = 240; source.value = initial.source || ''; source.placeholder = '例如：这道作文题的主体段';
    const example = node('textarea'); example.rows = 2; example.maxLength = 2000; example.value = initial.example || ''; example.placeholder = '写一句自己的使用例句（可选）';
    const status = node('p', '', 'learning-status'); status.setAttribute('role', 'status');
    const save = node('button', '保存表达', 'learning-primary'); save.type = 'button'; save.dataset.saveExpression = '';
    save.addEventListener('click', () => {
      try {
        saveExpression({ ...initial, text: text.value, category: category.value, tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), source: source.value, example: example.value });
        status.textContent = '表达已保存到本机。'; status.dataset.error = 'false'; onSave?.();
      } catch (error) { status.textContent = error.message; status.dataset.error = 'true'; }
    });
    host.append(label('表达内容', text), label('用途分类', category), label('标签（可选）', tags), label('来源说明（可选）', source), label('我的例句（可选）', example), save, status);
    return { text, status };
  }
  function showExpressionCapture({ text = '', context: ctx, record }) {
    const dialog = node('dialog', undefined, 'learning-capture');
    const initial = record ? validExpression(record) : { text: string(text, 2000), context: context(ctx), category: ctx?.module === 'translation' ? 'translation' : 'other', tags: [] };
    const heading = node('h2', record ? '编辑我的表达' : '收藏到我的表达库');
    const close = node('button', '取消'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
    dialog.append(heading);
    const editor = expressionEditor(dialog, initial, () => dialog.close());
    dialog.append(close); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal(); editor.text.focus();
  }
  function mountExpressions({ container, getTarget, context: ctx }) {
    if (!container || typeof getTarget !== 'function') return;
    const wrapper = node('details', undefined, 'learning-expressions');
    wrapper.append(node('summary', '我的句子与表达库'));
    const capture = node('button', '收藏选中的表达'); capture.type = 'button'; capture.dataset.captureExpression = '';
    const query = node('input'); query.type = 'search'; query.placeholder = '搜索表达、标签或例句'; query.maxLength = 120; query.setAttribute('aria-label', '搜索我的表达');
    const filter = node('select'); filter.setAttribute('aria-label', '表达用途'); filter.append(node('option', '全部用途')); filter.firstChild.value = '';
    Object.entries(categories).forEach(([id, title]) => { const option = node('option', title); option.value = id; filter.append(option); });
    const list = node('div', undefined, 'learning-expression-list');
    const state = node('p', '', 'learning-status'); state.setAttribute('role', 'status');
    function render() {
      try {
        const term = query.value.toLocaleLowerCase();
        const all = expressions();
        const visible = all.filter((entry) => (!filter.value || entry.category === filter.value) && `${entry.text} ${entry.tags.join(' ')} ${entry.example}`.toLocaleLowerCase().includes(term));
        list.replaceChildren();
        if (!visible.length) list.append(node('p', '尚无匹配表达。先在正文中选择一句话并收藏。'));
        visible.slice(0, 30).forEach((entry) => {
          const card = node('article', undefined, 'learning-expression-card');
          card.append(node('small', `${categories[entry.category]} · ${entry.tags.join(' / ')}`), node('p', entry.text));
          if (entry.example) card.append(node('small', `我的例句：${entry.example}`));
          if (entry.source) card.append(node('small', `来源：${entry.source}`));
          const insert = node('button', '插入当前编辑位置'); insert.type = 'button'; insert.dataset.insertExpression = entry.id;
          insert.addEventListener('click', () => {
            const target = getTarget();
            if (!(target instanceof HTMLTextAreaElement) || target.readOnly || target.disabled) { state.textContent = '先点击你要插入的正文段落。'; return; }
            const start = target.selectionStart; const end = target.selectionEnd;
            const result = target.value.slice(0, start) + entry.text + target.value.slice(end);
            if (target.maxLength > 0 && result.length > target.maxLength) { state.textContent = '插入后将超过正文长度限制，当前内容未更改。'; return; }
            target.setRangeText(entry.text, start, end, 'end'); target.dispatchEvent(new Event('input', { bubbles: true }));
            state.textContent = target.value === result ? '已插入当前编辑位置，请结合题目调整表达。' : '编辑器未接受本次插入，请检查长度限制。'; target.focus();
          });
          const edit = node('button', '编辑表达'); edit.type = 'button'; edit.addEventListener('click', () => showExpressionCapture({ record: entry }));
          card.append(insert, edit); list.append(card);
        });
        state.textContent = `本机共 ${all.length} 条；匹配 ${visible.length} 条${visible.length > 30 ? '，显示前 30 条，请缩小搜索范围' : ''}。`;
      } catch (error) { state.textContent = error.message; }
    }
    capture.addEventListener('click', () => {
      const target = getTarget();
      const selected = target instanceof HTMLTextAreaElement ? target.value.slice(target.selectionStart, target.selectionEnd).trim() : '';
      try { showExpressionCapture({ text: selected, context: ctx }); } catch (error) { state.textContent = error.message; }
    });
    query.addEventListener('input', render); filter.addEventListener('change', render);
    wrapper.append(capture, query, filter, list, state); container.replaceChildren(wrapper);
    window.addEventListener('learning-store-changed', render);
    window.addEventListener('storage', (event) => { if (event.key === EXPRESSION_KEY) render(); });
    render();
  }
  function allowedKey(key) { return keys.has(key) || /^exam-viewer:[A-Za-z0-9][A-Za-z0-9._-]{0,79}:v1(?::note-drafts)?$/.test(key); }
  function validateSlots(slots) { boundedArray(slots, 40).forEach((slot) => { if (!object(slot)) throw new Error('填空格式无效。'); string(slot.name, 80); string(slot.value, 1000); if (slot.type && !['word', 'sentence'].includes(slot.type)) throw new Error('填空类型无效。'); }); }
  function validateNote(note) {
    if (!object(note)) throw new Error('翻译笔记格式无效。');
    if (typeof note.paper !== 'string' || typeof note.question !== 'string' || !(note.page === null || Number.isInteger(note.page) && note.page >= 1 && note.page <= 999)) throw new Error('翻译笔记定位字段缺失或无效。');
    const ctx = context(note);
    const expected = ctx.paper ? `${ctx.paper}:${ctx.question ? `question:${ctx.question}` : `page:${ctx.page || 1}`}` : 'personal';
    if (note.contextKey !== expected) throw new Error('翻译笔记定位不匹配。');
    string(note.updatedAt, 80);
    ['original', 'firstDraft', 'revised', 'reason', 'method', 'freeNote'].forEach((name) => string(note[name]));
    if (note.methodRefs !== undefined) {
      boundedArray(note.methodRefs, 32).forEach((ref) => { if (!object(ref) || !['github', 'personal'].includes(ref.source)) throw new Error('方法关联无效。'); string(ref.id, 160); string(ref.title, 160); if (!ref.id.trim() || /[\r\n]/.test(ref.id) || !ref.title.trim()) throw new Error('方法关联名称或标识无效。'); });
      unique(note.methodRefs, (ref) => `${ref.source}:${ref.id}`);
    }
  }
  function unique(entries, id) { if (new Set(entries.map(id)).size !== entries.length) throw new Error('资料包含重复标识。'); }
  function validateData(key, value) {
    if (!allowedKey(key)) throw new Error('备份包含非学习资料字段，不能恢复。');
    safeTree(value);
    if (/^exam-viewer:.*:v1$/.test(key)) return validateExam(value);
    if (key.endsWith(':note-drafts')) {
      boundedArray(value, 1000).forEach((draft) => {
        if (!object(draft) || typeof draft.key !== 'string' || !draft.key || !Number.isInteger(draft.page) || draft.page < 1 || draft.page > 999) throw new Error('阅读笔记草稿定位无效。');
        string(draft.key, 10000); string(draft.tagId || '', 160); string(draft.note || '', 6000); string(draft.label || '', 16); string(draft.quote || '', 1200);
        const rects = boundedArray(draft.rects, 80);
        if (!rects.length || rects.some((rect) => !object(rect) || !['x', 'y', 'width', 'height'].every((field) => typeof rect[field] === 'number' && Number.isFinite(rect[field])) || rect.width <= 0 || rect.height <= 0)) throw new Error('阅读笔记草稿坐标无效。');
      }); unique(value, (item) => item.key); return value;
    }
    if (key === 'cet:translation-notes:v1') { boundedArray(value, 200).forEach(validateNote); unique(value, (item) => item.contextKey); }
    else if (key === 'cet:translation-method:v1') { string(value.source, 24000); string(value.updatedAt, 80); }
    else if (key === 'cet:translation-note-drafts:v1') {
      if (value.version !== 1) throw new Error('草稿版本不支持。');
      boundedArray(value.notes, 200).forEach(validateNote); unique(value.notes, (item) => item.contextKey);
      if (value.method !== null) { if (!object(value.method)) throw new Error('个人方法草稿无效。'); string(value.method.source, 24000); }
    } else if (key === 'cet:writing-template-library:v1') {
      boundedArray(value, 30).forEach((entry) => { string(entry.id, 80); string(entry.name, 80); string(entry.source); if (!/^[A-Za-z0-9._-]{1,80}$/.test(entry.id) || !entry.name.trim() || !entry.source.trim()) throw new Error('模板名称、正文或标识无效。'); validateSlots(entry.slots); if (window.WritingTemplates) window.WritingTemplates.parse(entry.source, entry.slots); }); unique(value, (item) => item.id);
    } else if (key === 'cet:writing-template-draft:v1') {
      string(value.activeKey, 160); boundedArray(value.entries, 40).forEach((entry) => { string(entry.key, 160); string(entry.name, 80); string(entry.source); if (!entry.key || entry.id !== null && (typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(entry.id))) throw new Error('模板草稿标识无效。'); validateSlots(entry.slots); }); unique(value.entries, (item) => item.key);
    } else if (key === 'cet:writing-answers:v1') {
      if (value.version !== 1) throw new Error('作文草稿版本不支持。');
      boundedArray(value.entries, 200).forEach((entry) => { const ctx = context(entry); if (!ctx.paper || typeof entry.question !== 'string' || ctx.question && !/^(?:q[1-9][0-9]{0,2}|writing-[1-9][0-9]{0,2})$/.test(ctx.question) || !ctx.question && ctx.page === null || entry.contextKey !== `${ctx.paper}:${ctx.question || `page-${ctx.page}`}`) throw new Error('作文草稿定位不匹配。'); string(entry.source); string(entry.answer || ''); validateSlots(entry.slots); string(entry.name, 80); if (entry.prompt !== undefined) string(entry.prompt, 24000); }); unique(value.entries, (item) => item.contextKey);
    } else if (key === EXPRESSION_KEY) {
      if (value.version !== 1) throw new Error('表达库版本不支持。'); boundedArray(value.entries, 500).forEach(validExpression); unique(value.entries, (item) => item.id);
    } else if (key === 'cet:learning-review:v1') {
      if (value.version !== 1 || !object(value.entries) || Object.keys(value.entries).length > 500) throw new Error('复习记录格式无效。'); Object.entries(value.entries).forEach(([id, answer]) => { string(id, 300); string(answer); });
    }
    return value;
  }
  function backup() {
    const records = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!allowedKey(key)) continue;
      const raw = localStorage.getItem(key);
      // Keep damaged raw text recoverable in exports; normal restoration
      // explicitly rejects it rather than silently overwriting another record.
      try { records.push({ key, value: validateData(key, JSON.parse(raw)) }); }
      catch (_error) { records.push({ key, raw, unreadable: true }); }
    }
    return { format: 'cet-learning-backup', version: 1, createdAt: new Date().toISOString(), records };
  }
  function parseBackup(input) {
    if (typeof input !== 'string' || new TextEncoder().encode(input).length > 8 * 1024 * 1024) throw new Error('备份最大 8 MB。');
    let data; try { data = JSON.parse(input); } catch (_error) { throw new Error('备份不是有效 JSON。'); }
    if (!object(data) || data.format !== 'cet-learning-backup' || data.version !== 1) throw new Error('不是本平台支持的版本 1 学习备份。');
    safeTree(data);
    if (Object.keys(data).some((key) => !['format', 'version', 'createdAt', 'records'].includes(key))) throw new Error('备份包含未知字段，未执行恢复。');
    if (data.createdAt !== undefined) string(data.createdAt, 80);
    boundedArray(data.records, 1000); unique(data.records, (entry) => entry.key);
    data.records.forEach((entry) => { if (!object(entry) || entry.unreadable || typeof entry.key !== 'string') throw new Error('备份含损坏的原始资料，请先修复后恢复；现有资料未更改。'); if (Object.keys(entry).some((key) => !['key', 'value'].includes(key))) throw new Error('备份条目包含未知字段。'); validateData(entry.key, entry.value); });
    return data;
  }
  function mergeArray(existing, incoming, identity) {
    const map = new Map(existing.map((item) => [identity(item), item]));
    incoming.forEach((item) => map.set(identity(item), item)); return [...map.values()];
  }
  function mergedData(key, previous, incoming) {
    if (previous === undefined) return incoming;
    validateData(key, previous);
    if (key === 'cet:translation-notes:v1') return mergeArray(previous, incoming, (item) => item.contextKey);
    if (key === 'cet:writing-template-library:v1') return mergeArray(previous, incoming, (item) => item.id);
    if (['cet:writing-answers:v1', EXPRESSION_KEY].includes(key)) return { ...previous, ...incoming, entries: mergeArray(previous.entries, incoming.entries, (item) => item.contextKey || item.id) };
    if (key === 'cet:writing-template-draft:v1') return { ...previous, ...incoming, entries: mergeArray(previous.entries, incoming.entries, (item) => item.key) };
    if (key === 'cet:translation-note-drafts:v1') return { ...previous, ...incoming, notes: mergeArray(previous.notes, incoming.notes, (item) => item.contextKey) };
    if (key === 'cet:learning-review:v1') return { ...previous, ...incoming, entries: { ...previous.entries, ...incoming.entries } };
    if (/^exam-viewer:.*:v1$/.test(key)) return { ...previous, ...incoming, answers: { ...(previous.answers || {}), ...(incoming.answers || {}) }, annotations: mergeArray(previous.annotations || [], incoming.annotations || [], (item) => item.id), submitted: false, grade: null };
    if (key.endsWith(':note-drafts')) return mergeArray(previous, incoming, (item) => item.key || item.id);
    return incoming;
  }
  function restoreBackup(data) {
    // Revalidate and merge against the freshest storage, never a stale preview.
    const parsed = parseBackup(JSON.stringify(data));
    const changes = parsed.records.map(({ key, value }) => {
      const original = localStorage.getItem(key);
      const merged = mergedData(key, original === null ? undefined : read(key), value);
      validateData(key, merged); return { key, original, serialized: JSON.stringify(merged) };
    });
    const written = [];
    try { changes.forEach((entry) => { localStorage.setItem(entry.key, entry.serialized); written.push(entry); }); }
    catch (_error) {
      let rollbackFailed = false;
      written.reverse().forEach((entry) => { try { if (entry.original === null) localStorage.removeItem(entry.key); else localStorage.setItem(entry.key, entry.original); } catch (_restoreError) { rollbackFailed = true; } });
      throw new Error(rollbackFailed ? '恢复失败，部分回滚未成功。请使用恢复前下载的备份检查资料，不要关闭当前页面。' : '恢复失败，已撤回本次写入。现有资料保持不变，请检查存储空间。');
    }
    window.dispatchEvent(new CustomEvent('learning-store-changed'));
    return changes.length;
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type })); const link = node('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  window.LearningStore = Object.freeze({ read, write, context, readerLink, readExam, applyAnswer, expressions, saveExpression, removeExpression, categories, mountExpressions, showExpressionCapture, backup, parseBackup, restoreBackup, validateData, download });
})();
