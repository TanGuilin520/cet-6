(() => {
  'use strict';
  const store = window.LearningStore;
  const $ = (id) => document.getElementById(id);
  const types = { reader: '试卷笔记', translation: '翻译对照', writing: '作文成稿', expression: '句子与表达' };
  const kinds = ['reader', 'translation', 'writing', 'expression'];
  let records = [];
  let pendingBackup = null;
  let warnings = [];
  function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
  function status(text, error = false) { $('learning-status').textContent = text; $('learning-status').dataset.error = String(error); }
  function data(key, fallback) {
    try { const value = store.read(key, fallback); return store.validateData(key, value); }
    catch (_error) { warnings.push(key); return fallback; }
  }
  function loadRecords() {
    warnings = []; const result = [];
    data('cet:translation-notes:v1', []).forEach((note) => result.push({
      ...note, id: `translation:${note.contextKey}`, kind: 'translation',
      title: (note.original || note.freeNote || '翻译对照笔记').slice(0, 75),
      source: note.original, revised: note.revised, tags: (note.methodRefs || []).map((ref) => ref.title),
      parts: [['我的初译', note.firstDraft], ['修改后', note.revised], ['为什么修改', note.reason], ['使用的方法', note.method], ['自由笔记', note.freeNote]],
    }));
    data('cet:writing-answers:v1', { version: 1, entries: [] }).entries.forEach((entry) => {
      let answer = entry.answer;
      try { answer = window.WritingTemplates.compile(entry); } catch (_error) { answer = entry.source; }
      result.push({ ...entry, id: `writing:${entry.contextKey}`, kind: 'writing', title: entry.name || '本题作文草稿', source: entry.prompt || '根据原题要求，尝试组织开头、主体与结尾。', revised: answer, tags: [], parts: [['当前作文成稿 / 草稿', answer]] });
    });
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const match = /^exam-viewer:([A-Za-z0-9][A-Za-z0-9._-]{0,79}):v1$/.exec(key);
      if (!match) continue;
      const exam = data(key, {}); const paper = match[1];
      (exam.annotations || []).filter((item) => item.type === 'tag').forEach((tag) => result.push({
        id: `reader:${paper}:${tag.id}`, kind: 'reader', paper, question: '', page: tag.page, noteId: tag.id,
        title: tag.label || '试卷笔记', source: tag.quote || '', revised: tag.note || '', tags: [tag.label || '重点'],
        updatedAt: new Date(Math.abs(Number(tag.createdAt) || 0) <= 8640000000000000 ? Number(tag.createdAt) || 0 : 0).toISOString(), parts: [['我的笔记', tag.note]],
      }));
      Object.entries(exam.answers || {}).filter(([id]) => /^(?:writing|translation)-/.test(id)).forEach(([question, answer]) => {
        const kind = question.startsWith('writing-') ? 'writing' : 'translation';
        if (result.some((record) => record.kind === kind && record.paper === paper && record.question === question)) return;
        result.push({ id: `answer:${paper}:${question}`, kind, paper, question, page: null, title: '试卷中保存的作答', source: '查看原题后重新尝试。', revised: answer, tags: [], parts: [['已保存作答', answer]], updatedAt: '' });
      });
    }
    try { store.expressions().forEach((entry) => result.push({ ...entry.context, ...entry, id: `expression:${entry.id}`, expressionId: entry.id, expressionRecord: entry, kind: 'expression', title: store.categories[entry.category], source: entry.source, revised: entry.text, parts: [['表达', entry.text], ['我的例句', entry.example]] })); }
    catch (_error) { warnings.push('cet:expression-library:v1'); }
    records = result.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const selected = $('learning-paper').value;
    $('learning-paper').replaceChildren();
    const all = node('option', '全部试卷'); all.value = ''; const personal = node('option', '独立资料'); personal.value = 'personal'; $('learning-paper').append(all, personal);
    [...new Set(records.map((record) => record.paper).filter(Boolean))].forEach((paper) => { const option = node('option', paper); option.value = paper; $('learning-paper').append(option); });
    $('learning-paper').value = [...$('learning-paper').options].some((option) => option.value === selected) ? selected : '';
    render();
    status(warnings.length ? `${warnings.length} 个资料分区无法读取，已保持原样。JSON 导出仍保留其原始内容，请先备份检查。` : `已读取 ${records.length} 条本机记录。`, warnings.length > 0);
  }
  function filtered() {
    const type = $('learning-type').value; const paper = $('learning-paper').value; const query = $('learning-search').value.trim().toLocaleLowerCase();
    return records.filter((record) => (!type || record.kind === type) && (!paper || (paper === 'personal' ? !record.paper : record.paper === paper)) && `${record.title} ${record.paper || ''} ${record.source || ''} ${record.parts.flat().join(' ')} ${record.tags.join(' ')}`.toLocaleLowerCase().includes(query));
  }
  function render() {
    const visible = filtered(); const review = $('learning-review-mode').checked;
    $('learning-count').textContent = `${visible.length} / ${records.length} 条记录`;
    const nodes = visible.map((record) => {
      const card = node('article', undefined, 'learning-record'); card.dataset.learningRecord = record.id;
      const header = node('header'); const caption = node('div');
      caption.append(node('span', types[record.kind], 'record-kind'), node('h3', record.title));
      const meta = [record.paper || '独立资料', record.question || '', record.page ? `第 ${record.page} 页` : ''].filter(Boolean).join(' · ');
      caption.append(node('span', meta, 'record-meta')); header.append(caption); card.append(header);
      if (record.tags.length) card.append(node('div', record.tags.join(' / '), 'record-tags'));
      if (record.source) { card.append(node('h4', record.kind === 'expression' ? '来源说明' : '原文 / 定位'), node('p', record.source)); }
      const comparison = node('div', undefined, 'learning-comparison'); comparison.dataset.comparison = ''; comparison.hidden = review;
      record.parts.forEach(([label, value]) => { if (value) comparison.append(node('h4', label), node('p', value)); });
      if (review) {
        const practice = node('div', undefined, 'learning-review-area');
        const field = node('label', '先重新尝试，再展开对照', 'learning-field'); const input = node('textarea'); input.rows = 4; input.maxLength = 12000; input.dataset.reviewAttempt = '';
        try { const previous = store.read('cet:learning-review:v1', { version: 1, entries: {} }); store.validateData('cet:learning-review:v1', previous); input.value = previous.entries[record.id] || ''; } catch (_error) { /* Keep unreadable review data unchanged. */ }
        field.append(input); const save = node('button', '保存这次重练'); save.type = 'button';
        save.addEventListener('click', () => {
          try {
            const latest = store.read('cet:learning-review:v1', { version: 1, entries: {} }); store.validateData('cet:learning-review:v1', latest);
            const merged = { version: 1, entries: { ...latest.entries, [record.id]: input.value } }; store.validateData('cet:learning-review:v1', merged); store.write('cet:learning-review:v1', merged); status('重练内容已保留，原作答和笔记没有修改。');
          } catch (error) { status(error.message, true); }
        });
        const reveal = node('button', '展开修改稿 / 笔记对照'); reveal.type = 'button'; reveal.dataset.revealComparison = ''; reveal.setAttribute('aria-expanded', 'false');
        reveal.addEventListener('click', () => { comparison.hidden = !comparison.hidden; reveal.setAttribute('aria-expanded', String(!comparison.hidden)); reveal.textContent = comparison.hidden ? '展开修改稿 / 笔记对照' : '隐藏对照'; });
        practice.append(field, save, reveal); card.append(practice);
      }
      card.append(comparison);
      const actions = node('div', undefined, 'record-actions');
      const link = store.readerLink(record); if (link) { const anchor = node('a', '回到试卷位置 →'); anchor.href = link; actions.append(anchor); }
      if (['writing', 'translation'].includes(record.kind)) {
        const params = new URLSearchParams(); if (record.paper) params.set('paper', record.paper); if (record.question) params.set('question', record.question); if (record.page) params.set('page', record.page);
        const anchor = node('a', '继续编辑'); anchor.href = `${record.kind}.html${params.size ? `?${params}` : ''}`; actions.append(anchor);
      }
      if (record.expressionId) {
        const edit = node('button', '编辑表达'); edit.type = 'button'; edit.addEventListener('click', () => store.showExpressionCapture({ record: record.expressionRecord })); actions.append(edit);
        const remove = node('button', '删除这条表达'); remove.type = 'button'; remove.addEventListener('click', () => { if (!confirm('删除这条表达？请先备份需要保留的内容。')) return; try { store.removeExpression(record.expressionId); } catch (error) { status(error.message, true); } }); actions.append(remove);
      }
      card.append(actions); return card;
    });
    if (!nodes.length) nodes.push(node('p', records.length ? '没有匹配记录，试试其他关键词或筛选条件。' : '还没有学习记录。从试卷保存笔记、在工作台保存本题草稿，或收藏自己的表达后，会显示在这里。', 'learning-empty'));
    $('learning-records').replaceChildren(...nodes);
  }
  ['learning-search', 'learning-type', 'learning-paper'].forEach((id) => $(id).addEventListener(id === 'learning-search' ? 'input' : 'change', render));
  $('learning-review-mode').addEventListener('change', render);
  $('learning-refresh').addEventListener('click', loadRecords);
  $('learning-new-expression').addEventListener('click', () => store.showExpressionCapture({ text: '', context: { module: 'personal' } }));
  $('learning-export-md').addEventListener('click', () => {
    const markdown = ['# 我的学习记录', '', ...filtered().flatMap((record) => [`## ${types[record.kind]} · ${record.title}`, '', `定位：${record.paper || '独立资料'} ${record.question || ''} ${record.page ? `第 ${record.page} 页` : ''}`, '', ...(record.tags.length ? [`标签 / 方法：${record.tags.join('、')}`, ''] : []), ...(record.source ? ['### 原文 / 来源', '', record.source, ''] : []), ...record.parts.flatMap(([label, value]) => value ? [`### ${label}`, '', value, ''] : [])])].join('\n');
    store.download('cet-learning-records.md', markdown, 'text/markdown;charset=utf-8'); status('已导出筛选记录，包含完整修改稿 / 笔记。');
  });
  $('learning-export-json').addEventListener('click', () => { try { store.download('cet-learning-backup.json', JSON.stringify(store.backup(), null, 2), 'application/json'); status('已导出本机完整学习备份，请妥善保存。'); } catch (error) { status(error.message, true); } });
  $('learning-backup-file').addEventListener('change', async (event) => {
    pendingBackup = null; $('learning-import-preview').hidden = true;
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (!/\.json$/i.test(file.name) || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的 JSON 备份。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); pendingBackup = store.parseBackup(text);
      const overlaps = pendingBackup.records.filter((record) => localStorage.getItem(record.key) !== null).length;
      $('learning-import-summary').textContent = `备份包含 ${pendingBackup.records.length} 个资料分区，与本机重叠 ${overlaps} 个。文件验证通过，尚未写入任何资料。`;
      $('learning-import-preview').hidden = false; status('请检查恢复说明，再确认合并。');
    } catch (error) { status(error instanceof TypeError ? '备份必须是 UTF-8 JSON，现有资料未更改。' : error.message, true); }
    finally { event.target.value = ''; }
  });
  $('learning-cancel-import').addEventListener('click', () => { pendingBackup = null; $('learning-import-preview').hidden = true; status('已取消恢复，现有资料未改变。'); });
  $('learning-confirm-import').addEventListener('click', () => {
    if (!pendingBackup || !confirm('确认合并恢复？相同标识的记录将使用备份版本，请先关闭其他编辑页面。')) return;
    try {
      store.download('cet-learning-before-restore.json', JSON.stringify(store.backup(), null, 2), 'application/json');
      const count = store.restoreBackup(pendingBackup); pendingBackup = null; $('learning-import-preview').hidden = true; loadRecords(); status(`已合并 ${count} 个资料分区。恢复前备份已下载，原来其他记录仍保留。`);
    } catch (error) { status(error.message, true); }
  });
  window.addEventListener('storage', loadRecords);
  window.addEventListener('learning-store-changed', (event) => { if (event.detail?.key !== 'cet:learning-review:v1') loadRecords(); });
  if (kinds.includes(new URLSearchParams(location.search).get('type'))) $('learning-type').value = new URLSearchParams(location.search).get('type');
  loadRecords();
})();
