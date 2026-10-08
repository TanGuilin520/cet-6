const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT, PAPER_ID } = require('./reader-fixture.cjs');

const METHODS_API = '/api/learning-methods/translation-notes';
const NOTES_KEY = 'cet:translation-notes:v1';
const DRAFTS_KEY = 'cet:translation-note-drafts:v1';
const SECOND_PAPER = 'translation-second-fixture';
const ORIGINAL = '随着学习不断深入，我们能够表达得更准确。\n这种改变离不开持续练习。';

function questions(stem = `Part IV Translation\nDirections: For this part, you are allowed 30 minutes to translate a passage from Chinese into English.\n${ORIGINAL}`) {
  return [
    {
      questionId: 'q1', number: 1, type: 'single_choice', page: 1,
      stem: 'A synthetic reading question.', confidence: 0.99,
      bbox: { x: 140, y: 180, width: 300, height: 100 },
      options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} option` })),
    },
    {
      questionId: 'translation-1', number: 61, type: 'translation', page: 2,
      stem, confidence: 0.99,
      bbox: { x: 100, y: 180, width: 450, height: 250 },
    },
  ];
}

function manifest({ chinese = true } = {}) {
  return {
    title: 'Synthetic translation workspace paper', pageCount: 2,
    pages: [
      { number: 1, width: 595, height: 842, image: 'translation-page-1.png',
        words: ['Learning', 'English', 'takes', 'practice.'].map((text, index) => ({
          id: index + 1, text, line: 1, x: 145 + index * 68, y: 120, width: 63, height: 20,
        })),
      },
      { number: 2, width: 595, height: 842, image: 'translation-page-2.png', words: [
        { id: 5, text: 'Translation', line: 1, x: 225, y: 70, width: 100, height: 22 },
        { id: 6, text: 'Directions: For this part, translate the following paragraph.', line: 2, x: 100, y: 110, width: 440, height: 20 },
        ...(chinese ? ORIGINAL.split('\n').map((text, index) => ({
          id: 7 + index, text, line: 3 + index, x: 110, y: 220 + index * 36, width: 400, height: 22,
        })) : []),
      ] },
    ],
  };
}

function catalog({ count = 18, attack = false } = {}) {
  const cards = [
    { id: 'with-as', title: '随着：with 与 as', category: '句型方法', keywords: ['随着', 'with', 'as'],
      bodyMarkdown: '## 先判断结构\n\nwith + 名词；as + 完整分句。\n\n> As our studies deepen, we make progress.' },
    { id: 'tense', title: '时态与时间线', category: '翻译步骤', keywords: ['时态', '时间'], bodyMarkdown: '先确认事件发生的时间，再选择时态。' },
    { id: 'word-order', title: '主干与语序', category: '翻译步骤', keywords: ['主干', '修饰'], bodyMarkdown: '先识别主语和谓语，再处理修饰语。' },
  ];
  if (attack) cards[0].bodyMarkdown += '\n\n<img src="https://forbidden.example/evil.png" onerror="window.__translationXss=1">\n<script>window.__translationXss=2</script>\n![remote](https://forbidden.example/image.png)\n[bad](javascript:window.__translationXss=3)';
  while (cards.length < count) cards.push({
    id: `method-${cards.length + 1}`, title: `练习步骤 ${cards.length + 1}`, category: '学习笔记',
    keywords: [`步骤${cards.length + 1}`], bodyMarkdown: `第 ${cards.length + 1} 条合成测试方法。`,
  });
  return {
    status: 'ready', count: cards.length, cards,
    source: {
      repositoryUrl: 'https://github.com/TanGuilin520/CET6-Translation-Notes',
      fileUrl: 'https://github.com/TanGuilin520/CET6-Translation-Notes/blob/master/README.md',
      rawUrl: 'https://raw.githubusercontent.com/TanGuilin520/CET6-Translation-Notes/master/README.md',
      branch: 'master', kind: 'personal_notes', attribution: 'TanGuilin520 的个人翻译学习笔记',
      caution: '学习方法资料，不是官方试卷解析。', fetchedAt: '2026-10-08T00:00:00Z', sha256: 'a'.repeat(64),
    },
  };
}

async function setupWorkspace(page, { stem, chinese = true, methods = catalog(), alternateQuestions } = {}) {
  const items = questions(stem);
  const control = await setupReader(page, { questions: items });
  control.catalogGets = 0;
  control.refreshRequests = [];
  control.refreshStatus = 200;
  control.refreshPayload = methods;
  await page.route(`**${METHODS_API}`, async (route) => {
    control.catalogGets += 1;
    return route.fulfill({ json: methods });
  });
  await page.route(`**${METHODS_API}/refresh`, async (route) => {
    control.refreshRequests.push({ method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ status: control.refreshStatus, json: control.refreshPayload });
  });
  const pageManifest = manifest({ chinese });
  await page.route(`**${API_ROOT}/manifest`, (route) => route.fulfill({ json: pageManifest }));
  await page.route(`**/api/exams/${SECOND_PAPER}/questions`, (route) => route.fulfill({ json: {
    revision: 1, questions: alternateQuestions || questions('第二份试卷：学习需要坚持。'),
  } }));
  await page.route(`**/api/exams/${SECOND_PAPER}/manifest`, (route) => route.fulfill({ json: pageManifest }));
  await page.reload();
  await expect(page.locator('.pdf-page-shell')).toHaveCount(2);
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator('#question-navigator button')).toHaveCount(items.length);
  return control;
}

async function openWorkspace(page, paper = PAPER_ID, question = 'translation-1') {
  await page.goto(`/translation.html?paper=${paper}&question=${question}&page=2`);
  await expect(page.locator('#translation-source-text')).toBeVisible();
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(18);
}

function assertClean(control) {
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.requests).toEqual([]);
}

function storedNote(paper = PAPER_ID, changes = {}) {
  return {
    contextKey: `${paper}:question:translation-1`, paper, question: 'translation-1', page: 2,
    original: '我此前选择的一句原文。', firstDraft: 'A previous personal attempt.', revised: '', reason: '',
    method: '', freeNote: '以前保存的独立心得。', updatedAt: '2026-10-08T00:00:00Z', ...changes,
  };
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: the blue translation marker directly opens the workspace and returns to its original question`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const control = await setupWorkspace(page);
    if (name === 'mobile') await page.locator('#toggle-question-panel').click();
    await page.locator('[data-navigate-question="translation-1"]').click();
    if (name === 'mobile') await page.locator('#toggle-question-panel').click();
    const answer = 'As our studies deepen, we can express ourselves more accurately.';
    await page.locator('[data-long-answer="translation-1"]').fill(answer);
    if (name === 'mobile') await page.locator('#close-question-panel').click();
    const marker = page.locator('[data-toggle-page-question="translation-1"]');
    await marker.click();
    await expect(page).toHaveURL(/\/translation\.html\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get('paper')).toBe(PAPER_ID);
    expect(url.searchParams.get('question')).toBe('translation-1');
    expect(url.searchParams.get('page')).toBe('2');
    await expect(page.locator('#translation-source-text')).toHaveValue(/随着学习不断深入/);
    await expect(page.locator('#translation-source-text')).not.toHaveValue(/Directions|For this part/);
    await expect(page.locator('#translation-first-draft')).toHaveValue(answer);
    await page.locator('#translation-first-draft').fill('Only my learning notebook changes here.');
    await page.locator('#back-to-reader').click();
    await expect(page.locator('#viewer-loading')).toBeHidden();
    await expect(page.locator('#current-page')).toHaveValue('2');
    await expect(page.locator('[data-navigate-question="translation-1"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[data-long-answer="translation-1"]')).toHaveValue(answer);
    expect(control.refreshRequests).toEqual([]);
    assertClean(control);
  });
}

test('the Chinese paragraph can be reconstructed from verified page words when the extracted stem is only directions', async ({ page }) => {
  const control = await setupWorkspace(page, { stem: 'Directions: Translate the following paragraph from Chinese into English.' });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue(/随着学习不断深入/);
  await expect(page.locator('#translation-source-text')).toHaveValue(/这种改变离不开持续练习/);
  await expect(page.locator('#translation-source-text')).not.toHaveValue(/Directions|Translation/);
  assertClean(control);
});

test('a flattened page-number and website footer is removed without changing quantities in the original', async ({ page }) => {
  const original = '截至2025年3月底，企业数量超过5700万户，占总量的92.3%。发展带来了更多机会。';
  const control = await setupWorkspace(page, { stem: `Part IV Translation Directions: Translate this paragraph. ${original} 8 https://zhenti.burningvocabulary.cn` });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue(original);
  assertClean(control);
});

test('a separate footer row with its page number is not included in the practice paragraph', async ({ page }) => {
  const control = await setupWorkspace(page, { stem: `${ORIGINAL}\n8 https://zhenti.burningvocabulary.cn` });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue(ORIGINAL);
  assertClean(control);
});

test('English-only source data does not invent a Chinese paragraph and remains manually editable', async ({ page }) => {
  const control = await setupWorkspace(page, { stem: 'Translate the following paragraph.', chinese: false });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue('');
  await expect(page.locator('#translation-original-state')).toContainText(/手动|未找到|没有|原文/);
  await page.locator('#translation-source-text').fill('这是我手动提供的原文。');
  await page.locator('#save-translation-note').click();
  await page.reload();
  await expect(page.locator('#translation-source-text')).toHaveValue('这是我手动提供的原文。');
  assertClean(control);
});

test('saved notebook fields are never replaced automatically, and importing the current paragraph needs confirmation', async ({ page }) => {
  const control = await setupWorkspace(page);
  const note = storedNote();
  await page.evaluate(({ key, record }) => localStorage.setItem(key, JSON.stringify([record])), { key: NOTES_KEY, record: note });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue(note.original);
  await expect(page.locator('#translation-first-draft')).toHaveValue(note.firstDraft);
  await expect(page.locator('#translation-free-note')).toHaveValue(note.freeNote);
  await expect(page.locator('#load-translation-original')).toBeEnabled();
  const dismissed = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await Promise.all([dismissed, page.locator('#load-translation-original').click()]);
  await expect(page.locator('#translation-original-state')).toHaveText('已保留你当前的原句。');
  await expect(page.locator('#translation-source-text')).toHaveValue(note.original);
  const accepted = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await Promise.all([accepted, page.locator('#load-translation-original').click()]);
  await expect(page.locator('#translation-source-text')).toHaveValue(/随着学习不断深入/);
  await expect(page.locator('#translation-first-draft')).toHaveValue(note.firstDraft);
  await expect(page.locator('#translation-free-note')).toHaveValue(note.freeNote);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key))[0].original, NOTES_KEY)).toBe(note.original);
  assertClean(control);
});

test('an existing editing draft takes priority over source autofill and saved notebook content', async ({ page }) => {
  const control = await setupWorkspace(page);
  const note = storedNote();
  const draft = storedNote(PAPER_ID, { original: '最新但尚未正式保存的原句。', firstDraft: 'My unsaved draft is important.' });
  await page.evaluate(({ noteKey, draftKey, note, draft }) => {
    localStorage.setItem(noteKey, JSON.stringify([note]));
    localStorage.setItem(draftKey, JSON.stringify({ version: 1, method: null, notes: [draft] }));
  }, { noteKey: NOTES_KEY, draftKey: DRAFTS_KEY, note, draft });
  await openWorkspace(page);
  await expect(page.locator('#translation-source-text')).toHaveValue(draft.original);
  await expect(page.locator('#translation-first-draft')).toHaveValue(draft.firstDraft);
  await page.reload();
  await expect(page.locator('#translation-source-text')).toHaveValue(draft.original);
  assertClean(control);
});

test('a saved free-form-only note stays optional instead of having its empty fields silently populated', async ({ page }) => {
  const control = await setupWorkspace(page);
  await page.locator('[data-navigate-question="translation-1"]').click();
  await page.locator('[data-long-answer="translation-1"]').fill('This exam answer is not part of my free-form notebook.');
  const note = storedNote(PAPER_ID, { original: '', firstDraft: '', freeNote: '我只想记录这条自由笔记。' });
  await page.evaluate(({ key, record }) => localStorage.setItem(key, JSON.stringify([record])), { key: NOTES_KEY, record: note });
  await openWorkspace(page);
  await expect(page.locator('#load-translation-original')).toBeEnabled();
  await expect(page.locator('#translation-source-text')).toHaveValue('');
  await expect(page.locator('#translation-first-draft')).toHaveValue('');
  await expect(page.locator('#translation-free-note')).toHaveValue(note.freeNote);
  assertClean(control);
});

test('a delayed source response cannot overwrite text that the learner already typed', async ({ page }) => {
  const control = await setupWorkspace(page);
  let resolveSource;
  const sourceAvailable = new Promise((resolve) => { resolveSource = resolve; });
  await page.route(`**${API_ROOT}/questions`, async (route) => {
    await sourceAvailable;
    return route.fulfill({ json: { revision: 1, questions: questions() } });
  });
  await openWorkspace(page);
  await page.locator('#translation-source-text').fill('请求尚未完成时我已经手动记录的原句。');
  await page.locator('#translation-first-draft').fill('My current manual draft.');
  resolveSource();
  await expect(page.locator('#load-translation-original')).toBeEnabled();
  await expect(page.locator('#translation-source-text')).toHaveValue('请求尚未完成时我已经手动记录的原句。');
  await expect(page.locator('#translation-first-draft')).toHaveValue('My current manual draft.');
  assertClean(control);
});

test('cached GitHub methods support search, attributed detail and explicit appending without changing personal source', async ({ page }) => {
  const control = await setupWorkspace(page);
  await openWorkspace(page);
  await expect(page.locator('#translation-method-count')).toContainText('18');
  await expect(page.locator('#translation-source-attribution')).toContainText(/个人|TanGuilin520/);
  await page.locator('#translation-source-personal').click();
  await page.locator('#translation-method-source').fill('这是独立编辑的个人方法。');
  await page.locator('#translation-source-github').click();
  await page.locator('#translation-used-method').fill('我已记录的方法。');
  await page.locator('#translation-method-search').fill('随着');
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(1);
  await page.locator('[data-method-id="with-as"]').click();
  await expect(page.locator('#translation-method-detail-title')).toHaveText('随着：with 与 as');
  await expect(page.locator('#translation-method-detail')).toContainText('with + 名词');
  await page.locator('#use-translation-method').click();
  await expect(page.locator('#translation-used-method')).toHaveValue(/我已记录的方法。/);
  await expect(page.locator('#translation-used-method')).toHaveValue(/随着：with 与 as/);
  await page.locator('#translation-source-personal').click();
  await expect(page.locator('#translation-method-source')).toHaveValue('这是独立编辑的个人方法。');
  expect(control.refreshRequests).toEqual([]);
  assertClean(control);
});

test('personal Markdown methods have their own catalog without overwriting the GitHub collection', async ({ page }) => {
  const control = await setupWorkspace(page);
  await openWorkspace(page);
  await page.locator('#translation-source-personal').click();
  await page.locator('#translation-method-source').fill('# 第1节：判断主干\n先确认主谓。\n### 我的例句\nWe learn.\n\n## 2. 调整语序\n把长修饰语放到合适的位置。');
  await page.locator('#save-translation-method').click();
  await expect(page.locator('#translation-source-personal')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(2);
  await page.locator('#translation-method-catalog [data-method-id]').first().click();
  await expect(page.locator('#translation-method-detail')).toContainText('We learn.');
  await page.locator('#translation-source-github').click();
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(18);
  assertClean(control);
});

test('refresh is only explicit, updates the cached catalog, and preserves old cards when the server refresh fails', async ({ page }) => {
  const control = await setupWorkspace(page);
  await openWorkspace(page);
  expect(control.refreshRequests).toEqual([]);
  control.refreshPayload = catalog({ count: 3 });
  await page.locator('#refresh-translation-methods').click();
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(3);
  expect(control.refreshRequests).toEqual([{ method: 'POST', body: {} }]);
  control.refreshStatus = 502;
  control.refreshPayload = { error: 'GitHub 暂时不可用，已保留缓存。', errorCode: 'source_unavailable', cachedAvailable: true };
  await page.locator('#refresh-translation-methods').click();
  await expect(page.locator('#translation-catalog-status')).toContainText(/失败|不可用|保留|缓存/);
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(3);
  expect(control.refreshRequests).toHaveLength(2);
  assertClean(control);
});

test('Markdown HTML, remote images and unsafe URLs remain inert and never request the external source', async ({ page }) => {
  const control = await setupWorkspace(page, { methods: catalog({ attack: true }) });
  await openWorkspace(page);
  await page.locator('[data-method-id="with-as"]').click();
  await expect(page.locator('#translation-method-detail')).toContainText('with + 名词');
  await expect(page.locator('#translation-method-detail img, #translation-method-detail script')).toHaveCount(0);
  await expect(page.locator('#translation-method-detail a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__translationXss)).toBeUndefined();
  assertClean(control);
});

test('different papers keep separate notes and unverified question IDs cannot read stale exam answers', async ({ page }) => {
  const control = await setupWorkspace(page, { alternateQuestions: questions().filter((question) => question.questionId !== 'translation-1') });
  await openWorkspace(page);
  await page.locator('#translation-free-note').fill('只属于第一份试卷的笔记。');
  await page.locator('#save-translation-note').click();
  await page.evaluate((paper) => localStorage.setItem(`exam-viewer:${paper}:v1`, JSON.stringify({
    answers: { 'translation-1': 'A stale answer belonging to an unverified ID.' },
  })), SECOND_PAPER);
  await openWorkspace(page, SECOND_PAPER);
  await expect(page.locator('#translation-source-text')).toHaveValue('');
  await expect(page.locator('#translation-first-draft')).toHaveValue('');
  await expect(page.locator('#translation-free-note')).toHaveValue('');
  await page.locator('#translation-free-note').fill('第二份试卷的独立笔记。');
  await page.locator('#save-translation-note').click();
  await openWorkspace(page);
  await expect(page.locator('#translation-free-note')).toHaveValue('只属于第一份试卷的笔记。');
  assertClean(control);
});

test('an existing multiple-choice question is not accepted as a verified translation source', async ({ page }) => {
  const control = await setupWorkspace(page);
  await page.addInitScript((paper) => {
    if (location.pathname === '/translation.html') localStorage.setItem(`exam-viewer:${paper}:v1`, JSON.stringify({
      answers: { q1: 'A choice answer that must not become a translation draft.' },
    }));
  }, PAPER_ID);
  await openWorkspace(page, PAPER_ID, 'q1');
  await expect(page.locator('#translation-source-text')).toHaveValue('');
  await expect(page.locator('#translation-first-draft')).toHaveValue('');
  await expect(page.locator('#load-translation-original')).toBeDisabled();
  assertClean(control);
});

test('the three-column workspace stacks on a 390px mobile viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await setupWorkspace(page);
  await openWorkspace(page);
  await page.locator('[data-translation-view="methods"]').click();
  await page.locator('[data-method-id="with-as"]').click();
  await expect(page.locator('#translation-method-detail')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.locator('#translation-source-personal').click();
  await page.locator('[data-translation-view="resources"]').click();
  await page.locator('#translation-method-source').fill('A'.repeat(1000));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  assertClean(control);
});
