(() => {
  'use strict';

  // This module only reads the selected paper. It deliberately never reads an
  // answer PDF, calls AI, or changes the user's template, fill-ins or drafts.
  const byId = (id) => document.getElementById(id);
  const promptElement = byId('writing-task-prompt');
  const stateElement = byId('writing-task-state');
  const contextElement = byId('writing-task-context');
  const limitElement = byId('writing-task-word-limit');
  const MAX_PROMPT_CHARS = 24000;
  const MAX_PAGE_WORDS = 15000;
  const PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const QUESTION_ID = /^(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2})$/;
  const PAGE_NUMBER = /^[1-9][0-9]{0,2}$/;
  const params = new URLSearchParams(location.search);
  const suppliedPaper = params.get('paper') || '';
  const suppliedQuestion = params.get('question') || '';
  const suppliedPage = params.get('page') || '';
  const paper = PAPER_ID.test(suppliedPaper) ? suppliedPaper : '';
  const question = QUESTION_ID.test(suppliedQuestion) ? suppliedQuestion : '';
  const requestedPage = PAGE_NUMBER.test(suppliedPage) ? Number(suppliedPage) : null;

  function publish(status, message, details = {}) {
    const result = Object.freeze({
      status, paper, question,
      page: Object.prototype.hasOwnProperty.call(details, 'page') ? details.page : requestedPage,
      prompt: details.prompt || '', wordLimit: details.wordLimit || null,
      source: details.source || null,
      revision: Number.isInteger(details.revision) && details.revision >= 0 ? details.revision : null,
      questionFingerprint: details.questionFingerprint || null,
    });
    window.WritingTaskContext = result;
    if (stateElement) stateElement.textContent = message;
    if (promptElement) {
      promptElement.textContent = result.prompt;
      promptElement.hidden = !result.prompt;
    }
    if (limitElement) {
      limitElement.hidden = !result.wordLimit;
      limitElement.textContent = result.wordLimit ? `${result.wordLimit.min}–${result.wordLimit.max} 词` : '';
    }
    window.dispatchEvent(new CustomEvent('writing-task-loaded', { detail: result }));
    return result;
  }

  function cleanText(value) {
    if (typeof value !== 'string' || value.includes('\0') || value.length > MAX_PROMPT_CHARS) return '';
    const rows = value.replace(/\r\n?/g, '\n')
      .replace(/([。！？.!?])\s+\d{1,3}\s+(?:https?:\/\/|www\.)\S+\s*$/, '$1').trim().split('\n');
    // Strip only trailing footer rows. A numeric row in the middle of an OCR
    // task may be part of its word limit and must not be silently deleted.
    const footer = /^\s*(?:(?:\d{1,3}\s+)?(?:https?:\/\/\S+|www\.\S+)|\d{1,3}|第\s*\d+\s*页)\s*$/;
    while (rows.length && footer.test(rows[rows.length - 1])) rows.pop();
    return rows.join('\n').trim();
  }

  const writingHeading = /^(?:(?:part|section)\s*[ivx\d]+\s*[-:.)]?\s*)?(?:writing|写作|作文)(?:\s*[\[(（]\s*\d{1,3}\s*(?:minutes?|mins?|分钟)\s*[\])）])?\s*$/i;
  const nextSection = /^(?:(?:part|section)\s+[ivx\dA-Z]+\b|(?:listening|reading)(?:\s+comprehension)?(?:\s*[\[(（]\s*\d{1,3}\s*(?:minutes?|mins?|分钟)\s*[\])）])?\s*$|translation(?:\s*[\[(（]\s*\d{1,3}\s*(?:minutes?|mins?|分钟)\s*[\])）])?\s*$|听力(?:理解)?\s*$|阅读(?:理解)?\s*$|翻译\s*$)/i;

  function meaningfulPrompt(text) {
    if (!text || text.length > MAX_PROMPT_CHARS) return false;
    // A detected heading alone is not an extracted writing task.
    const body = text.split('\n').filter((line) => !writingHeading.test(line.trim())).join(' ').trim();
    return body.length >= 12 && (body.match(/[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length >= 8;
  }

  function promptFromQuestion(current) {
    const values = [current?.stem, current?.prompt, current?.text];
    for (const value of values) {
      let text = cleanText(value);
      if (!text) continue;
      let rows = text.split('\n');
      const starts = rows.reduce((indices, row, index) => {
        if (writingHeading.test(row.trim())) indices.push(index);
        return indices;
      }, []);
      if (starts.length > 1) continue;
      if (starts.length === 1) rows = rows.slice(starts[0]);
      const end = rows.findIndex((row, index) => index > 0 && nextSection.test(row.trim()));
      if (end >= 0) rows = rows.slice(0, end);
      text = rows.join('\n').trim();
      // Some PDF extractors flatten the entire page into one line. An explicit
      // Part ... Writing heading is safe to locate, unlike the word "writing"
      // appearing in an ordinary sentence or an essay title.
      const flattenedStart = /\b(?:part|section)\s+[ivx\d]+\s*[-:.)]?\s+writing\b/i.exec(text);
      if (flattenedStart) text = text.slice(flattenedStart.index);
      const flattenedEnd = /\b(?:part|section)\s+[ivx\d]+\s*[-:.)]?\s+(?:listening(?:\s+comprehension)?|reading(?:\s+comprehension)?|translation)\b/i.exec(text);
      if (flattenedEnd) text = text.slice(0, flattenedEnd.index).trim();
      if (meaningfulPrompt(text)) return text;
    }
    return '';
  }

  function visualRows(pageData) {
    const rawWords = pageData?.words;
    if (!Array.isArray(rawWords) || rawWords.length > MAX_PAGE_WORDS) return [];
    const words = rawWords.filter((word) => word && typeof word.text === 'string'
      && word.text.length <= MAX_PROMPT_CHARS && !word.text.includes('\0')
      && Number.isFinite(Number(word.x)) && Number.isFinite(Number(word.y))
      && Number(word.x) >= 0 && Number(word.y) >= 0)
      .map((word) => ({ text: word.text, x: Number(word.x), y: Number(word.y) }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    words.forEach((word) => {
      // PDF -bbox-layout may assign different line IDs to Part I, Writing and
      // (30 minutes), despite all three being on one visual line. Merge by y.
      let row = rows[rows.length - 1];
      if (!row || Math.abs(word.y - row.y) > 2.6) {
        row = { y: word.y, words: [] };
        rows.push(row);
      }
      row.words.push(word);
    });
    return rows.map((row) => ({
      y: row.y,
      text: row.words.sort((a, b) => a.x - b.x).map((word) => word.text.trim()).join(' ')
        .replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '$1').trim(),
    }));
  }

  function promptFromPage(pageData, current = null) {
    const rows = visualRows(pageData);
    const starts = rows.reduce((indices, row, index) => {
      if (writingHeading.test(row.text)) indices.push(index);
      return indices;
    }, []);
    if (starts.length === 1) {
      const start = starts[0];
      const end = rows.findIndex((row, index) => index > start && nextSection.test(row.text));
      const section = rows.slice(start, end < 0 ? rows.length : end);
      const text = cleanText(section.map((row) => row.text).join('\n'));
      if (meaningfulPrompt(text)) return text;
    }
    // A question-bound bbox is a valid fallback only for an already verified
    // writing question. It is never used to guess a task for a page-only link.
    const bbox = current?.bbox;
    if (starts.length === 0 && bbox && Number.isFinite(Number(bbox.y)) && Number(bbox.y) >= 0
      && Number.isFinite(Number(bbox.height)) && Number(bbox.height) > 0) {
      const bounded = rows.filter((row) => row.y >= Number(bbox.y) - 2.6
        && row.y < Number(bbox.y) + Number(bbox.height));
      const end = bounded.findIndex((row) => nextSection.test(row.text));
      const text = cleanText((end < 0 ? bounded : bounded.slice(0, end)).map((row) => row.text).join('\n'));
      if (meaningfulPrompt(text)) return text;
    }
    return '';
  }

  function explicitWordLimit(text) {
    const normalized = text.replace(/\s+/g, ' ');
    const patterns = [
      /\bat\s+least\s+(\d{1,5})\s+(?:words?\s+)?(?:but|and)\s+(?:no|not)\s+more\s+than\s+(\d{1,5})\s+words?\b/gi,
      /\bno\s+less\s+than\s+(\d{1,5})\s+(?:words?\s+)?(?:but|and)\s+(?:no|not)\s+more\s+than\s+(\d{1,5})\s+words?\b/gi,
      /\bbetween\s+(\d{1,5})\s+and\s+(\d{1,5})\s+words?\b/gi,
      /\b(\d{1,5})\s*[-–—~]\s*(\d{1,5})\s+words?\b/gi,
      /(?:不少于|至少)\s*(\d{1,5})\s*(?:词|字)?\s*(?:且|并且|但|，|,)?\s*(?:不超过|不多于|最多)\s*(\d{1,5})\s*(?:词|字)/g,
      /(\d{1,5})\s*[-–—~至]\s*(\d{1,5})\s*(?:词|字)/g,
    ];
    const ranges = [];
    let invalid = false;
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(normalized)) !== null) {
        const min = Number(match[1]);
        const max = Number(match[2]);
        if (min <= 0 || min > max || max > 10000) invalid = true;
        else ranges.push({ min, max });
      }
    });
    const distinct = new Set(ranges.map(({ min, max }) => `${min}:${max}`));
    return !invalid && distinct.size === 1 ? ranges[0] : null;
  }

  async function loadTask() {
    if (!suppliedPaper) {
      if (contextElement) contextElement.textContent = '独立写作练习 · 模板与草稿保存在当前浏览器。';
      publish('independent', '从试卷上的“作文模板”进入，可在这里带入当前作文题目；现在也可以独立整理自己的模板。');
      return;
    }
    if (!paper || (suppliedQuestion && !question) || (!question && !requestedPage)) {
      publish('unavailable', '无法确认试卷或题目定位信息。请返回原卷，从对应作文旁的按钮重新进入；已有模板和草稿未改变。');
      return;
    }
    if (stateElement) stateElement.textContent = '正在从原卷读取作文题目…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const getJson = async (suffix) => {
        const response = await fetch(`/api/exams/${encodeURIComponent(paper)}/${suffix}`, {
          signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' },
        });
        if (!response.ok) return null;
        return response.json();
      };
      const [questionResult, manifestResult] = await Promise.allSettled([getJson('questions'), getJson('manifest')]);
      const data = questionResult.status === 'fulfilled' ? questionResult.value : null;
      const manifest = manifestResult.status === 'fulfilled' ? manifestResult.value : null;
      const candidates = Array.isArray(data) ? data : data?.questions ?? data?.data?.questions ?? [];
      const current = question && Array.isArray(candidates) ? candidates.find((item) => item?.type === 'writing'
        && String(item.questionId ?? item.id ?? '') === question) : null;
      if (question && !current) {
        publish('unavailable', '未找到与当前题号绑定的作文题。请返回原卷查看；不会将其他题目或官方范文当作当前题目。');
        return;
      }
      const targetPage = current ? Number(current.page) : requestedPage;
      const actualPage = Number.isInteger(targetPage) && targetPage >= 1 && targetPage <= 999 ? targetPage : null;
      const pageData = actualPage && Array.isArray(manifest?.pages)
        ? manifest.pages.find((item) => Number(item?.number ?? item?.page) === actualPage) : null;
      const parsedPrompt = current ? promptFromQuestion(current) : '';
      const prompt = parsedPrompt || promptFromPage(pageData, current);
      const title = typeof manifest?.title === 'string' && !manifest.title.includes('\0') ? manifest.title.slice(0, 160) : '当前试卷';
      if (contextElement) contextElement.textContent = `${title}${actualPage ? ` · 第 ${actualPage} 页` : ''} · 原卷作文要求`;
      if (!prompt) {
        publish('unavailable', '没有提取到可确认的作文题目（可能尚未完成 OCR，或该页标题不明确）。请返回原卷查看；不会猜测题目，已有输入保持不变。', { page: actualPage });
        return;
      }
      publish('ready', parsedPrompt ? '已带入当前题的原卷要求，请对照试卷核验。题目展示不会覆盖你的模板和草稿。'
        : '已从当前页的文字坐标带入作文要求，请对照原卷核验。题目展示不会覆盖你的模板和草稿。', {
        page: actualPage, prompt, wordLimit: explicitWordLimit(prompt),
        source: parsedPrompt ? 'paper_question' : 'paper_words',
        revision: Number.isInteger(data?.revision) && data.revision >= 0 ? data.revision : null,
        questionFingerprint: current ? JSON.stringify({ page: current.page, stem: current.stem || '', prompt: current.prompt || '', text: current.text || '', bbox: current.bbox || null }) : null,
      });
    } catch (_error) {
      publish('unavailable', '作文题目暂时无法读取。请返回原卷查看，已有模板、填空与草稿保持不变。');
    } finally { clearTimeout(timer); }
  }

  loadTask();
})();
