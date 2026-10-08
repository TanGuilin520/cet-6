(() => {
  'use strict';

  const API = '/api/learning-methods/translation-notes';
  const REPOSITORY = 'https://github.com/TanGuilin520/CET6-Translation-Notes';
  const catalog = document.getElementById('translation-method-catalog');
  const search = document.getElementById('translation-method-search');
  const status = document.getElementById('translation-catalog-status');
  const count = document.getElementById('translation-method-count');
  const detail = document.getElementById('translation-method-detail');
  const title = document.getElementById('translation-method-detail-title');
  const category = document.getElementById('translation-method-category');
  const refresh = document.getElementById('refresh-translation-methods');
  const useButton = document.getElementById('use-translation-method');
  const useStatus = document.getElementById('translation-method-use-status');
  const personalInput = document.getElementById('translation-method-source');
  const usedMethod = document.getElementById('translation-used-method');
  const attribution = document.getElementById('translation-source-attribution');
  const caution = document.getElementById('translation-source-caution');
  const sourceLink = document.getElementById('translation-method-original-link');
  const updatedAt = document.getElementById('translation-method-updated-at');
  const tabs = Array.from(document.querySelectorAll('[data-method-source]'));
  if (!catalog || !personalInput || !usedMethod) return;

  let mode = 'github';
  let githubData = { status: 'not_imported', cards: [], source: {} };
  let loading = false;
  let readFinished = false;
  let failureMode = null;
  let githubNotice = '';
  let selected = null;
  let renderedDetailKey = '';
  let personalTimer = null;
  const selectedIds = { github: '', personal: '' };
  const queries = { github: '', personal: '' };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function safeHttps(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || value.length > 2000) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch (_error) { return null; }
  }

  // Construct a small, safe Markdown subset using text nodes only. Raw HTML is
  // displayed as text; images are never fetched, and links must be HTTPS.
  function appendInline(parent, value) {
    const tokens = /(!?\[[^\]\n]*\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g;
    let offset = 0;
    for (const match of value.matchAll(tokens)) {
      parent.append(document.createTextNode(value.slice(offset, match.index)));
      const token = match[0];
      if (token.startsWith('![')) {
        const label = token.slice(2, token.indexOf(']('));
        parent.append(element('span', label ? `[图片：${label}，不自动加载]` : '[图片不自动加载]'));
      } else if (token.startsWith('[')) {
        const boundary = token.indexOf('](');
        const label = token.slice(1, boundary);
        const href = safeHttps(token.slice(boundary + 2, -1));
        if (href) {
          const link = element('a', label);
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          parent.append(link);
        } else parent.append(document.createTextNode(token));
      } else if (token.startsWith('**') || token.startsWith('__')) parent.append(element('strong', token.slice(2, -2)));
      else if (token.startsWith('`')) parent.append(element('code', token.slice(1, -1)));
      else parent.append(element('em', token.slice(1, -1)));
      offset = match.index + token.length;
    }
    parent.append(document.createTextNode(value.slice(offset)));
  }

  function markdown(source) {
    const root = element('div', undefined, 'method-markdown');
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    function flush() {
      if (!paragraph.length) return;
      const node = element('p');
      appendInline(node, paragraph.join('\n'));
      root.append(node);
      paragraph = [];
    }
    function cells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()); }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      const bullet = /^\s*(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/.exec(line);
      if (/^\s*```/.test(line)) {
        flush(); list = null;
        const codeLines = [];
        while (++index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index]);
        const block = element('pre');
        block.append(element('code', codeLines.join('\n')));
        root.append(block);
      } else if (heading) {
        flush(); list = null;
        const node = element(`h${Math.min(4, Math.max(2, heading[1].length))}`);
        appendInline(node, heading[2]); root.append(node);
      } else if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        flush(); list = null; root.append(element('hr'));
      } else if (/^\s*>/.test(line)) {
        flush(); list = null;
        const block = element('blockquote');
        const quoteLines = [line.replace(/^\s*>\s?/, '')];
        while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) quoteLines.push(lines[++index].replace(/^\s*>\s?/, ''));
        appendInline(block, quoteLines.join('\n')); root.append(block);
      } else if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]) && cells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
        flush(); list = null;
        const wrapper = element('div', undefined, 'method-table-wrap');
        const table = element('table');
        const head = element('thead');
        const row = element('tr');
        const headers = cells(line);
        headers.forEach((cell) => { const node = element('th'); node.scope = 'col'; appendInline(node, cell); row.append(node); });
        head.append(row); table.append(head);
        const body = element('tbody');
        index += 1;
        while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|')) {
          const values = cells(lines[++index]);
          const bodyRow = element('tr');
          headers.forEach((_cell, position) => { const node = element('td'); appendInline(node, values[position] || ''); bodyRow.append(node); });
          body.append(bodyRow);
        }
        table.append(body); wrapper.append(table); root.append(wrapper);
      } else if (bullet) {
        flush();
        const listType = bullet[2] ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== listType) {
          list = element(listType);
          if (bullet[2]) list.start = Number(bullet[2]);
          root.append(list);
        }
        const item = element('li'); appendInline(item, bullet[3]); list.append(item);
      } else if (!line.trim()) { flush(); list = null; }
      else { list = null; paragraph.push(line); }
    }
    flush();
    return root;
  }

  function parsePersonal(source) {
    if (!source.trim()) return [];
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const sections = [];
    let current = null;
    let inCode = false;
    const preface = [];
    function finish() {
      if (!current) return;
      // Identity follows the heading rather than its position. Inserting a
      // preceding chapter must not redirect earlier mistake associations.
      let hash = 2166136261;
      for (const char of current.title.trim()) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
      const baseId = `personal-method-${(hash >>> 0).toString(16)}`;
      const duplicates = sections.filter((card) => card.id === baseId || card.id.startsWith(`${baseId}-`)).length;
      sections.push({ id: duplicates ? `${baseId}-${duplicates + 1}` : baseId, title: current.title.slice(0, 160), category: '我的翻译资料', bodyMarkdown: current.body.join('\n').trim(), keywords: [] });
    }
    for (const line of lines) {
      if (/^\s*```/.test(line)) inCode = !inCode;
      const heading = !inCode && /^(#{1,2})\s+((?:\d+[\s.、：:“”"'(（]|\d+[\u4e00-\u9fff]|第\s*[\d一二三四五六七八九十]+\s*[章节课部分]).*)$/.exec(line);
      if (heading && sections.length < 100) {
        finish();
        current = { title: heading[2].trim(), body: [] };
      } else if (current) current.body.push(line);
      else preface.push(line);
    }
    finish();
    if (!sections.length) return [{ id: 'personal-method-1', title: '我的翻译方法', category: '我的翻译资料', bodyMarkdown: source, keywords: [] }];
    // Preserve a document-level author or source preface without misclassifying
    // it as another method. It remains visible in the first method's source.
    const introduction = preface.join('\n').trim();
    if (introduction) sections[0].bodyMarkdown = `${introduction}\n\n${sections[0].bodyMarkdown}`;
    return sections;
  }

  function validatePayload(value) {
    if (!value || !['ready', 'not_imported'].includes(value.status) || !Array.isArray(value.cards) || value.cards.length > 128 || !value.source || typeof value.source !== 'object') throw new Error('资料格式无法读取，请重试；已有个人输入不会被覆盖。');
    const cards = value.cards.map((card) => {
      if (!card || typeof card.id !== 'string' || !card.id || card.id.length > 160 || typeof card.title !== 'string' || !card.title.trim() || card.title.length > 160 || typeof card.bodyMarkdown !== 'string' || card.bodyMarkdown.length > 100000) throw new Error('方法目录格式无效，已保留原有资料。');
      return { id: card.id, title: card.title, category: typeof card.category === 'string' ? card.category.slice(0, 80) : '翻译方法', bodyMarkdown: card.bodyMarkdown, keywords: Array.isArray(card.keywords) ? card.keywords.filter((item) => typeof item === 'string').slice(0, 30).map((item) => item.slice(0, 80)) : [] };
    });
    if (new Set(cards.map((card) => card.id)).size !== cards.length || (value.status === 'not_imported' && cards.length)) throw new Error('方法目录有冲突，已保留原有资料。');
    return { status: value.status, source: value.source, cards };
  }

  function sourceText(value, fallback) {
    if (typeof value === 'string') return value.slice(0, 1500);
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join('；').slice(0, 1500) || fallback;
    return fallback;
  }

  function renderSource() {
    if (mode === 'personal') {
      attribution.textContent = '资料来源：你在当前浏览器导入或编辑的个人翻译方法。';
      caution.textContent = '当前目录展示编辑器中的版本，未保存的修改也是草稿；请结合句子语境核对。';
      sourceLink.hidden = true;
      updatedAt.textContent = '';
      return;
    }
    attribution.textContent = sourceText(githubData.source.attribution, '糯糯不爱吃糖根据四六级邹老师授课内容整理；仓库维护：TanGuilin520。');
    caution.textContent = sourceText(githubData.source.caution, '个人学习笔记与课程整理，不是官方答案解析；例句保留原文，使用时请结合上下文核对。');
    sourceLink.href = safeHttps(githubData.source.fileUrl) || safeHttps(githubData.source.repositoryUrl) || REPOSITORY;
    sourceLink.hidden = false;
    const date = typeof githubData.source.fetchedAt === 'string' ? new Date(githubData.source.fetchedAt) : null;
    updatedAt.textContent = date && Number.isFinite(date.getTime()) ? `资料缓存于 ${date.toLocaleString('zh-CN')}` : '点击左侧加载，读取公开仓库中的原始学习资料。';
  }

  function renderDetail() {
    renderSource();
    // Keep the current section in memory for an explicitly consented request;
    // selecting it never uploads any personal content on its own.
    window.TranslationMethodSelection = selected ? { source: mode, id: selected.id, title: selected.title, bodyMarkdown: selected.bodyMarkdown } : null;
    renderHistory();
    const key = selected ? `${mode}:${selected.id}:${selected.bodyMarkdown}` : `${mode}:empty`;
    useButton.disabled = !selected;
    if (key === renderedDetailKey) return;
    renderedDetailKey = key;
    useStatus.textContent = '关联方法并记录名称，不替你改写答案。';
    useStatus.dataset.error = 'false';
    title.textContent = selected ? selected.title : '方法与例句';
    category.textContent = selected ? selected.category : '';
    category.hidden = !selected;
    detail.replaceChildren();
    if (selected) detail.append(markdown(selected.bodyMarkdown || '这项方法还没有正文。可以在个人资料中补充自己的步骤和例句。'));
    else {
      const empty = element('div', undefined, 'method-detail-empty');
      empty.append(element('span', 'Aa'), element('h3', '把方法放在手边'), element('p', mode === 'personal' ? '在下方整理自己的方法，再从左侧选择一项。也可以先只写自由笔记。' : '选择左侧的方法，在这里对照原始学习笔记和例句，再回到你的翻译。'));
      empty.firstChild.setAttribute('aria-hidden', 'true');
      detail.append(empty);
    }
    detail.scrollTop = 0;
  }

  function renderHistory() {
    const container = document.getElementById('translation-method-history');
    if (!container) return;
    container.replaceChildren();
    if (!selected || !window.TranslationNotebook) { container.append(element('p', '选择方法，查看关联过的初译、修改与原因。')); return; }
    try {
      // A public source may reuse a numbered ID after editing a chapter.
      // Without matching the stored title, do not attach old mistakes to an
      // unrelated replacement method or silently migrate their references.
      const notes = window.TranslationNotebook.readNotes().filter((note) => note.methodRefs.some((ref) => ref.source === mode && ref.id === selected.id && ref.title.trim() === selected.title.trim())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!notes.length) { container.append(element('p', '还没有关联这项方法的练习。点击“记录本次使用”，练习后保存笔记，就会出现在这里。')); return; }
      for (const note of notes.slice(0, 8)) {
        const record = element('details', undefined, 'translation-history-record');
        record.append(element('summary', `${note.paper || '独立练习'}${note.question ? ` · ${note.question}` : note.page ? ` · 第 ${note.page} 页` : ''}`));
        [['原句', note.original], ['我的初译', note.firstDraft], ['修改后', note.revised], ['为什么修改', note.reason]].forEach(([label, text]) => {
          if (!text.trim()) return;
          const block = element('p'); block.append(element('strong', `${label}：`), document.createTextNode(text)); record.append(block);
        });
        if (note.paper) {
          const query = new URLSearchParams({ paper: note.paper, cachefix: '20261008-learning-loop-1' });
          if (note.question) query.set('question', note.question);
          if (note.page) query.set('page', String(note.page));
          const link = element('a', '回到这道原题 ↗'); link.href = `reader.html?${query}`; record.append(link);
        }
        container.append(record);
      }
    } catch (error) { container.append(element('p', `${error.message} 已保留原有记录。`)); }
  }

  function renderCatalog() {
    const allCards = mode === 'github' ? githubData.cards : parsePersonal(personalInput.value);
    const query = search.value.trim().toLocaleLowerCase();
    const cards = query ? allCards.filter((card) => `${card.title}\n${card.category}\n${card.keywords.join(' ')}\n${card.bodyMarkdown}`.toLocaleLowerCase().includes(query)) : allCards;
    selected = cards.find((card) => card.id === selectedIds[mode]) || cards[0] || null;
    if (selected) selectedIds[mode] = selected.id;
    const previousScroll = catalog.scrollTop;
    catalog.replaceChildren();
    let previousCategory = '';
    for (const card of cards) {
      if (card.category !== previousCategory) {
        catalog.append(element('p', card.category, 'catalog-category'));
        previousCategory = card.category;
      }
      const button = element('button', undefined, 'method-card');
      button.type = 'button';
      button.dataset.methodId = card.id;
      button.setAttribute('aria-pressed', String(selected && selected.id === card.id));
      button.append(element('strong', card.title));
      if (card.keywords.length) button.append(element('small', card.keywords.slice(0, 3).join(' · ')));
      catalog.append(button);
    }
    if (!cards.length) catalog.append(element('p', query ? '没有匹配的方法。试试另一个关键词，或清空搜索。' : mode === 'personal' ? '还没有个人方法。可以在下方粘贴总结，或导入 TXT / MD。' : readFinished ? '还未加载 GitHub 笔记。点击下方按钮，将你的真实翻译总结放到手边。' : '正在读取本机服务的资料缓存…', 'catalog-empty'));
    catalog.scrollTop = previousScroll;
    count.textContent = query ? `${cards.length} / ${allCards.length}` : `${allCards.length} 项`;
    status.dataset.error = String(mode === 'github' && Boolean(failureMode));
    if (mode === 'personal') status.textContent = allCards.length ? '目录来自下方个人编辑器，不会被 GitHub 资料替换。' : '自己的资料，与 GitHub 总结分开保存。';
    else if (loading) status.textContent = readFinished ? '正在读取 GitHub 原始笔记，个人输入不会被覆盖…' : '正在读取服务器资料缓存…';
    else if (failureMode) status.textContent = githubNotice;
    else status.textContent = githubData.status === 'ready' ? `已加载 ${allCards.length} 项原始学习方法，例句保留原文。` : '尚未加载。不会在后台下载或调用 AI。';
    refresh.disabled = loading;
    refresh.textContent = loading ? '正在加载…' : failureMode === 'read' ? '重试读取资料缓存' : failureMode === 'refresh' ? '重试更新 GitHub 笔记' : githubData.status === 'ready' ? '更新 GitHub 笔记' : '加载 GitHub 笔记';
    refresh.hidden = mode === 'personal';
    renderDetail();
  }

  async function loadMethods(update = false) {
    if (loading) return;
    loading = true;
    renderCatalog();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), update ? 30000 : 10000);
    try {
      const response = await fetch(update ? `${API}/refresh` : API, update ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal } : { signal: controller.signal, cache: 'no-store' });
      let payload;
      try { payload = await response.json(); }
      catch (_error) { throw new Error('服务返回的资料无法读取，请确认平台服务已启动。'); }
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error.slice(0, 300) : '学习资料暂时无法加载，请稍后重试。');
      githubData = validatePayload(payload);
      failureMode = null;
      githubNotice = '';
    } catch (error) {
      failureMode = update ? 'refresh' : 'read';
      const message = error.name === 'AbortError' ? '加载超时，请稍后重试。' : error instanceof TypeError ? '无法连接平台服务，请确认服务器正在运行。' : error.message;
      githubNotice = `${message}${githubData.cards.length ? ' 已有目录和个人输入已保留。' : ' 个人输入不会被覆盖。'}`;
    } finally {
      clearTimeout(timer);
      loading = false;
      readFinished = true;
      renderCatalog();
    }
  }

  function switchSource(nextMode) {
    if (!['github', 'personal'].includes(nextMode)) return;
    queries[mode] = search.value;
    mode = nextMode;
    search.value = queries[mode];
    tabs.forEach((tab) => {
      const active = tab.dataset.methodSource === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    catalog.setAttribute('aria-labelledby', `translation-source-${mode}`);
    renderCatalog();
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchSource(tab.dataset.methodSource));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs.find((item) => item !== tab);
      if (target) { switchSource(target.dataset.methodSource); target.focus(); }
    });
  });
  search.addEventListener('input', renderCatalog);
  catalog.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-method-id]');
    if (!button || !catalog.contains(button)) return;
    selectedIds[mode] = button.dataset.methodId;
    renderCatalog();
    if (window.matchMedia('(max-width: 700px)').matches) detail.closest('.method-detail-panel').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  refresh.addEventListener('click', () => loadMethods(failureMode !== 'read'));
  document.querySelector('.catalog-personal-link').addEventListener('click', () => switchSource('personal'));
  useButton.addEventListener('click', () => {
    if (!selected) return;
    const name = selected.title.trim();
    if (usedMethod.value.split('\n').some((line) => line.trim() === name)) {
      window.dispatchEvent(new CustomEvent('translation-method-bound', { detail: { source: mode, id: selected.id, title: name } }));
      useStatus.textContent = '已关联这项方法，已有名称不重复添加。保存笔记后可查看历史练习。';
      useStatus.dataset.error = 'false';
      return;
    }
    const separator = usedMethod.value && !usedMethod.value.endsWith('\n') ? '\n' : '';
    const nextValue = `${usedMethod.value}${separator}${name}`;
    if (nextValue.length > usedMethod.maxLength) {
      useStatus.textContent = '“使用的方法”已达到字数限制。请整理当前内容后再记录，已有内容未改动。';
      useStatus.dataset.error = 'true';
      return;
    }
    usedMethod.value = nextValue;
    window.dispatchEvent(new CustomEvent('translation-method-bound', { detail: { source: mode, id: selected.id, title: name } }));
    usedMethod.dispatchEvent(new Event('input', { bubbles: true }));
    useStatus.textContent = `已关联并记录“${name}”，请在练习后保存这份笔记。`;
    useStatus.dataset.error = 'false';
  });
  function schedulePersonalRender() {
    clearTimeout(personalTimer);
    personalTimer = setTimeout(() => { if (mode === 'personal') renderCatalog(); }, 100);
  }
  personalInput.addEventListener('input', schedulePersonalRender);
  // The existing import flow sets the textarea's value after reading the file,
  // then changes this badge. Watch it rather than replacing that save logic.
  const methodState = document.getElementById('translation-method-state');
  if (methodState) new MutationObserver(schedulePersonalRender).observe(methodState, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', schedulePersonalRender);
  window.addEventListener('translation-notes-changed', renderHistory);
  window.addEventListener('storage', (event) => { if (event.key === 'cet:translation-notes:v1') renderHistory(); });
  window.TranslationMethodMarkdown = markdown;
  loadMethods();
})();
