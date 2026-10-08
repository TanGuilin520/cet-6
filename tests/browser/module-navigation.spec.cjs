const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT, PAPER_ID } = require('./reader-fixture.cjs');

const METHOD_KEY = 'cet:translation-method:v1';
const NOTES_KEY = 'cet:translation-notes:v1';

function moduleQuestions() {
  return [
    {
      questionId: 'q1', number: 1, type: 'single_choice', page: 1,
      stem: 'Synthetic reading question', confidence: 0.99,
      bbox: { x: 140, y: 180, width: 300, height: 100 },
      options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} option` })),
    },
    {
      questionId: 'translation-1', number: 61, type: 'translation', page: 1,
      stem: 'Translate the synthetic paragraph.', confidence: 0.99,
      bbox: { x: 140, y: 480, width: 300, height: 140 },
    },
    {
      questionId: 'writing-2', number: 2, type: 'writing', page: 2,
      stem: 'Write an essay about continuous learning.', confidence: 0.99,
      bbox: { x: 140, y: 250, width: 300, height: 140 },
    },
  ];
}

function word(text, index, number, position = {}) {
  return { id: number * 100 + index, text, line: 1, x: 145 + index * 68,
    y: 120, width: 63, height: 20, ...position };
}

function ordinaryWords(number) {
  return (number === 1 ? ['Learning', 'English', 'takes', 'practice.'] : ['Keep', 'learning.'])
    .map((text, index) => word(text, index, number));
}

function headingWords(number) {
  if (number === 1) return [
    word('Translation', 0, number, { x: 220, y: 70, line: 1, width: 105 }),
    ...['Learning', 'takes', 'practice.'].map((text, index) => word(text, index + 1, number, { line: 2 })),
  ];
  return [
    word('Writing', 0, number, { x: 220, y: 70, line: 1, width: 90 }),
    word('Translation', 1, number, { x: 220, y: 400, line: 2, width: 105 }),
  ];
}

async function setupModules(page, { questions = moduleQuestions(), wordsByPage } = {}) {
  const control = await setupReader(page, { questions });
  const pageWords = wordsByPage || [1, 2].map(questions.length ? ordinaryWords : headingWords);
  await page.route(`**${API_ROOT}/manifest`, (route) => route.fulfill({ json: {
    title: 'Synthetic module navigation paper', pageCount: 2,
    pages: [1, 2].map((number) => ({
      number, width: 595, height: 842, image: `module-page-${number}.png`,
      words: pageWords[number - 1],
    })),
  } }));
  await page.reload();
  await expect(page.locator('.pdf-page-shell')).toHaveCount(2);
  await expect(page.locator('.pdf-word')).toHaveCount(pageWords.reduce((count, words) => count + words.length, 0));
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator('#question-navigator button')).toHaveCount(questions.length);
  return control;
}

function moduleEntry(page, type, number) {
  return page.locator(`a[data-open-page-module="${type}"][href*="page=${number}"]`);
}

async function inspectHref(link) {
  const href = await link.evaluate((node) => node.href);
  const url = new URL(href);
  expect(url.origin).toBe(await link.evaluate(() => location.origin));
  return url;
}

async function expectModuleContext(link, type, number, question = null) {
  const url = await inspectHref(link);
  expect(url.pathname).toBe(`/${type}.html`);
  expect(url.searchParams.get('paper')).toBe(PAPER_ID);
  expect(url.searchParams.get('page')).toBe(String(number));
  expect(url.searchParams.get('question')).toBe(question);
}

async function expectModuleAnchor(page, link, number, targetY) {
  const button = await link.boundingBox();
  const paper = await page.locator(`.pdf-page-shell[data-page="${number}"] .pdf-page-surface`).boundingBox();
  const scale = paper.width / 595;
  expect(button.x + button.width).toBeLessThanOrEqual(paper.x + 1);
  expect(Math.abs((button.y - paper.y) / scale - targetY)).toBeLessThanOrEqual(2);
  expect(button.height).toBeGreaterThanOrEqual(33.5);
}

async function expectReturnedPage(page, number, question = null) {
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator('#current-page')).toHaveValue(String(number));
  await expect.poll(async () => {
    const viewport = await page.locator('#document-viewport').boundingBox();
    const paper = await page.locator(`.pdf-page-shell[data-page="${number}"] .pdf-page-surface`).boundingBox();
    return Boolean(viewport && paper && paper.y < viewport.y + viewport.height && paper.y + paper.height > viewport.y);
  }).toBe(true);
  if (question) {
    await expect(page.locator(`[data-navigate-question="${question}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator(`[data-long-answer="${question}"]`)).toBeVisible();
  }
}

function expectClean(control) {
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.requests).toEqual([]);
}

async function expectHorizontallyCentered(page) {
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.getElementById('document-viewport');
    const box = viewport.getBoundingClientRect();
    const center = box.left + viewport.clientLeft + viewport.clientWidth / 2;
    return Math.max(...[...document.querySelectorAll('.pdf-page-surface')].map((surface) => {
      const paper = surface.getBoundingClientRect();
      return Math.abs(paper.left + paper.width / 2 - center);
    }));
  }), { message: 'Question and module navigation preserve the centered original PDF, including horizontal overflow' }).toBeLessThanOrEqual(2);
}

test('zoomed question navigation and a translation round trip keep the original PDF horizontally centered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const control = await setupModules(page);
  for (let index = 0; index < 4; index += 1) {
    await page.locator('#zoom-in').click();
    await expectHorizontallyCentered(page);
  }
  await expect.poll(() => page.locator('#document-viewport').evaluate((viewport) => viewport.scrollWidth - viewport.clientWidth)).toBeGreaterThan(30);
  await page.locator('[data-navigate-question="q1"]').click();
  // Focus reaches the original-PDF marker only after the deferred question
  // positioning has run; checking earlier could miss a later horizontal pan.
  await expect(page.locator('[data-toggle-page-question="q1"]')).toBeFocused();
  await expectHorizontallyCentered(page);
  await moduleEntry(page, 'translation', 1).click();
  await expect(page.locator('#translation-source-text')).toBeVisible();
  await page.locator('#back-to-reader').click();
  await expectReturnedPage(page, 1, 'translation-1');
  await expect(page.locator('[data-toggle-page-question="translation-1"]')).toBeFocused();
  await expectHorizontallyCentered(page);
  expectClean(control);
});

for (const [name, size] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  test(`${name}: reliable heading entries stay left of the original PDF at their section positions through zoom`, async ({ page }) => {
    await page.setViewportSize(size);
    const control = await setupModules(page, { questions: [] });
    await expect(page.locator('a[data-open-page-module="writing"]')).toHaveCount(1);
    await expect(page.locator('a[data-open-page-module="translation"]')).toHaveCount(2);
    await expect(moduleEntry(page, 'writing', 1)).toHaveCount(0);
    await expect(page.locator('.pdf-page-actions')).toHaveCount(0);
    for (const type of ['writing', 'translation']) {
      const entry = moduleEntry(page, type, 2);
      await expect(entry).toHaveAccessibleName(type === 'writing' ? /^进入作文模板(?:，第 2 页)?$/ : /^翻译方法与笔记(?:，第 2 页)?$/);
      await expect(entry).toBeVisible();
      await entry.scrollIntoViewIfNeeded();
      await expectModuleAnchor(page, entry, 2, type === 'writing' ? 70 : 400);
    }
    const shell = await page.locator('.pdf-page-shell[data-page="2"]').boundingBox();
    const original = await page.locator('.pdf-page-shell[data-page="2"] .pdf-page-surface').boundingBox();
    expect(Math.abs(original.y - shell.y)).toBeLessThanOrEqual(1);
    for (const zoom of ['#zoom-out', '#zoom-out', '#zoom-in', '#zoom-in', '#zoom-in', '#zoom-in']) {
      await page.locator(zoom).click();
      for (const type of ['writing', 'translation']) {
        const entry = moduleEntry(page, type, 2);
        await expectModuleAnchor(page, entry, 2, type === 'writing' ? 70 : 400);
      }
    }
    expectClean(control);
  });
}

test('pages without a recognized question type or section title have no inline entries but keep global tools', async ({ page }) => {
  const control = await setupModules(page, { questions: [], wordsByPage: [ordinaryWords(1), ordinaryWords(2)] });
  await expect(page.locator('a[data-open-page-module]')).toHaveCount(0);
  await expect(page.locator('.pdf-page-actions')).toHaveCount(0);
  for (const [type, id] of [['writing', '#open-writing-library'], ['translation', '#open-translation-library']]) {
    const global = page.locator(id);
    await expect(global).toBeVisible();
    await expectModuleContext(global, type, 1);
    await global.click();
    await expect(page.locator(type === 'writing' ? '#writing-paragraph-intro' : '#translation-source-text')).toBeVisible();
    await page.locator('#back-to-reader').click();
    await expectReturnedPage(page, 1);
    await expect(page.locator('a[data-open-page-module]')).toHaveCount(0);
  }
  expectClean(control);
});

test('two real module questions on one page use their own exact question coordinates without duplicate links', async ({ page }) => {
  const questions = moduleQuestions().map((question) => question.questionId === 'writing-2'
    ? { ...question, page: 1 } : question);
  const wordsByPage = [
    [word('Writing', 0, 1, { x: 220, y: 70, line: 1 }), word('Translation', 1, 1, { x: 220, y: 380, line: 2, width: 105 })],
    ordinaryWords(2),
  ];
  const control = await setupModules(page, { questions, wordsByPage });
  await expect(page.locator('.page-module-entry-layer a[data-open-page-module]')).toHaveCount(2);
  const writing = moduleEntry(page, 'writing', 1);
  const translation = moduleEntry(page, 'translation', 1);
  await expectModuleContext(writing, 'writing', 1, 'writing-2');
  await expectModuleContext(translation, 'translation', 1, 'translation-1');
  await expectModuleAnchor(page, writing, 1, 250);
  await expectModuleAnchor(page, translation, 1, 480);
  await expect(writing).toHaveAttribute('data-open-writing-template', 'writing-2');
  await expect(translation).toHaveAttribute('data-open-translation-template', 'translation-1');
  await expect(page.locator('.page-question-card a[data-open-writing-template]')).toHaveCount(0);
  await expect(page.locator('.page-question-card a[data-open-translation-template]')).toHaveCount(1);
  await expect(page.locator('.page-question-card a[data-open-translation-template]')).toHaveAttribute('href', /translation\.html/);
  await expect(page.locator('.pdf-page-shell[data-page="2"] a[data-open-page-module]')).toHaveCount(0);
  expectClean(control);
});

test('desktop and mobile module entries never cover expanded, answered writing or translation controls', async ({ page }) => {
  // Reset the synthetic exam before each document initializes: clearing only
  // after a viewport run would be undone by the old reader's beforeunload save.
  await page.addInitScript((paper) => localStorage.removeItem(`exam-viewer:${paper}:v1`), PAPER_ID);
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const control = await setupModules(page);
    await expect(page.locator('[data-navigate-question="q1"]')).toHaveAttribute('aria-current', 'true');
    for (const question of [moduleQuestions()[2], moduleQuestions()[1]]) {
      const id = question.questionId;
      const marker = page.locator(`[data-toggle-page-question="${id}"]`);
      const card = page.locator(`.page-question-card[data-question-id="${id}"]`);
      const entry = moduleEntry(page, question.type, question.page);
      await expect(page.locator(`[data-navigate-question="${id}"]`)).not.toHaveAttribute('aria-current', 'true');
      if (question.type === 'translation') {
        // The blue translation marker is now a direct workspace link. Keep
        // in-reader answer controls available through the question navigator.
        await expect(marker).toHaveAttribute('href', /translation\.html/);
        if (size.width === 390) await page.locator('#toggle-question-panel').click();
        await page.locator(`[data-navigate-question="${id}"]`).click();
        if (size.width === 390) await expect(page.locator('#exam-viewer')).not.toHaveClass(/is-question-panel-open/);
      } else {
        await expect(marker).toHaveAttribute('aria-expanded', 'false');
        await marker.click();
        await expect(marker).toHaveAttribute('aria-expanded', 'true');
      }
      await expect(card).toHaveClass(/is-expanded/);
      await expect(page.locator(`[data-navigate-question="${id}"]`)).toHaveAttribute('aria-current', 'true');
      await card.locator(`[data-open-question="${id}"]`).click();
      const answer = `I wrote a personal ${question.type} answer.`;
      await page.locator(`[data-long-answer="${id}"]`).fill(answer);
      if (size.width === 390) {
        await page.locator('#close-question-panel').click();
        await expect(page.locator('#exam-viewer')).not.toHaveClass(/is-question-panel-open/);
      }
      await expect(card).toHaveClass(/is-answered/);
      await expect(marker).toHaveAttribute('data-answer', '✓');
      await expect(card.locator('.page-question-text-button')).toHaveText('已作答');
      await card.scrollIntoViewIfNeeded();
      await expectModuleAnchor(page, entry, question.page, question.bbox.y);
      await expect.poll(() => card.evaluate((element) => {
        const id = element.dataset.questionId;
        const link = [...document.querySelectorAll('a[data-open-page-module]')]
          .find((candidate) => candidate.dataset.moduleQuestion === id);
        const box = link.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('button, a.page-question-number')];
        const overlaps = [];
        const blocked = [];
        for (const button of buttons) {
          const rect = button.getBoundingClientRect();
          const width = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left));
          const height = Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
          if (width * height > 0) overlaps.push({ label: button.textContent, area: width * height });
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!(hit === button || button.contains(hit))) blocked.push({
            label: button.textContent, hit: hit ? `${hit.tagName}.${hit.className}` : null,
          });
        }
        const linkHit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { buttonCount: buttons.length, overlaps, blocked, moduleBlocked: !(linkHit === link || link.contains(linkHit)) };
      }), { message: `${size.width}px ${id}: module entry and expanded answered controls remain distinct clickable targets` })
        .toEqual({ buttonCount: 2, overlaps: [], blocked: [], moduleBlocked: false });
      await expect(page.locator(`[data-long-answer="${id}"]`)).toHaveValue(answer);
    }
    expectClean(control);
  }
});

test('missing question coordinates and unknown types do not invent spatial module entries', async ({ page }) => {
  const questions = [
    { ...moduleQuestions()[2], page: 1, bbox: null },
    { ...moduleQuestions()[1], page: 2, type: 'unknown', stem: 'Translation is mentioned here but the type has not been recognized.' },
  ];
  const control = await setupModules(page, { questions, wordsByPage: [ordinaryWords(1), ordinaryWords(2)] });
  await expect(page.locator('a[data-open-page-module]')).toHaveCount(0);
  await expect(page.locator('#question-navigator button')).toHaveCount(2);
  await expect(page.locator('#open-writing-library')).toBeVisible();
  await expect(page.locator('#open-translation-library')).toBeVisible();
  expectClean(control);
});

test('Writing and Translation mentioned inside ordinary prose are not section headings', async ({ page }) => {
  const wordsByPage = [
    ['Writing', 'English', 'is', 'useful.'].map((text, index) => word(text, index, 1)),
    ['Translation', 'requires', 'practice.'].map((text, index) => word(text, index, 2)),
  ];
  const control = await setupModules(page, { questions: [], wordsByPage });
  await expect(page.locator('a[data-open-page-module]')).toHaveCount(0);
  expectClean(control);
});

test('complete Part headings are reliable fallback anchors but never invent question IDs', async ({ page }) => {
  const wordsByPage = [
    [word('Part', 0, 1, { x: 170, y: 310, width: 42 }), word('IV', 1, 1, { x: 215, y: 310, width: 28 }), word('Translation', 2, 1, { x: 248, y: 310, width: 105 })],
    [word('Part', 0, 2, { x: 170, y: 210, width: 42 }), word('I', 1, 2, { x: 215, y: 210, width: 18 }), word('Writing', 2, 2, { x: 238, y: 210, width: 80 }), word('(30', 3, 2, { x: 323, y: 210, width: 32 }), word('minutes)', 4, 2, { x: 360, y: 210, width: 78 })],
  ];
  const control = await setupModules(page, { questions: [], wordsByPage });
  await expect(page.locator('a[data-open-page-module]')).toHaveCount(2);
  const writing = moduleEntry(page, 'writing', 2);
  const translation = moduleEntry(page, 'translation', 1);
  await expectModuleContext(writing, 'writing', 2);
  await expectModuleContext(translation, 'translation', 1);
  await expectModuleAnchor(page, writing, 2, 210);
  await expectModuleAnchor(page, translation, 1, 310);
  await expect(writing).not.toHaveAttribute('data-open-writing-template', /./);
  await expect(translation).not.toHaveAttribute('data-open-translation-template', /./);
  expectClean(control);
});

for (const type of ['writing', 'translation']) {
  test(`an unparsed page still opens ${type} tools and returns to page 2 without inventing a question`, async ({ page }) => {
    if (type === 'translation') await page.setViewportSize({ width: 390, height: 844 });
    const control = await setupModules(page, { questions: [] });
    const entry = moduleEntry(page, type, 2);
    await expect(entry).toBeVisible();
    await expectModuleContext(entry, type, 2);
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/${type}\\.html\\?`));
    const back = page.locator('#back-to-reader');
    await expect(back).toBeVisible();
    const context = await inspectHref(back);
    expect(context.pathname).toBe('/reader.html');
    expect(context.searchParams.get('paper')).toBe(PAPER_ID);
    expect(context.searchParams.get('page')).toBe('2');
    expect(context.searchParams.get('question')).toBeNull();
    if (type === 'writing') {
      await page.locator('#template-name').fill('没有识别题号也能创建的模板');
      await page.locator('#writing-mode-full').click();
      await page.locator('#template-source').fill('I believe {{观点}}.');
      await page.locator('#slot-fields [data-slot-name="观点"]').fill('practice matters');
      await page.locator('#save-template').click();
      await expect(page.locator('#writing-status')).toContainText('保存');
    } else {
      await page.locator('#translation-free-note').fill('这是未解析试卷第 2 页的个人翻译笔记。');
      await page.locator('#save-translation-note').click();
      await expect(page.locator('#translation-status')).toContainText('保存');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
    }
    await back.click();
    await expectReturnedPage(page, 2);
    await expect(page.locator('#question-navigator button')).toHaveCount(0);
    expectClean(control);
  });
}

test('opening a writing draft before its debounce fires preserves the latest source and slot value', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'writing', 2).click();
  await page.locator('#writing-scope-template').click();
  await page.locator('#template-name').fill('快速编辑的草稿');
  await page.locator('#writing-mode-full').click();
  await page.locator('#template-source').fill('Before: {{主题}}.');
  await page.locator('#slot-fields [data-slot-name="主题"]').fill('old expression');
  await expect(page.locator('#draft-list [data-draft-key]')).toHaveCount(1);
  await page.evaluate(() => {
    const source = document.getElementById('template-source');
    source.value = 'After: {{主题}}.';
    source.dispatchEvent(new Event('input', { bubbles: true }));
    const value = document.querySelector('#slot-fields [data-slot-name="主题"]');
    value.value = 'the latest expression';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    // One browser task: no 180 ms timer can hide a stale captured draft record.
    document.querySelector('#draft-list [data-draft-key]').click();
  });
  await expect(page.locator('#template-source')).toHaveValue('After: {{主题}}.');
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('the latest expression');
  const savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem('cet:writing-template-draft:v1')).entries.find((entry) => entry.name === '快速编辑的草稿'));
  expect(savedDraft.source).toBe('After: {{主题}}.');
  expect(savedDraft.slots[0].value).toBe('the latest expression');
  expectClean(control);
});

test('recognized module links use real matching question IDs and a question takes priority over page', async ({ page }) => {
  const control = await setupModules(page);
  await expectModuleContext(moduleEntry(page, 'writing', 2), 'writing', 2, 'writing-2');
  await expectModuleContext(moduleEntry(page, 'translation', 1), 'translation', 1, 'translation-1');
  await expect(moduleEntry(page, 'writing', 1)).toHaveCount(0);
  await expect(moduleEntry(page, 'translation', 2)).toHaveCount(0);
  await page.goto(`/reader.html?paper=${PAPER_ID}&page=1&question=writing-2`);
  await expectReturnedPage(page, 2, 'writing-2');
  expectClean(control);
});

test('a recognized translation question opens personal methods and notes and returns without replacing its answer', async ({ page }) => {
  const control = await setupModules(page);
  await page.locator('[data-navigate-question="translation-1"]').click();
  const answer = page.locator('[data-long-answer="translation-1"]');
  await answer.fill('My original translation answer is preserved.');
  await moduleEntry(page, 'translation', 1).click();
  await page.locator('#translation-method-source').fill('# 我的翻译方法\n先找主干，再处理修饰成分。');
  await page.locator('#save-translation-method').click();
  await expect(page.locator('#translation-status')).toContainText('保存');
  await page.locator('#translation-source-text').fill('随着学习不断深入，我们能够表达得更准确。');
  await page.locator('#translation-first-draft').fill('With study develops, we express better.');
  await page.locator('#translation-revised-text').fill('As our studies deepen, we can express ourselves more accurately.');
  await page.locator('#translation-revision-reason').fill('随着后面是完整分句，因此选择 as。');
  await page.locator('#translation-used-method').fill('随着：with + 名词 / as + 分句');
  await page.locator('#translation-free-note').fill('下次先判断后面是不是一个完整句子。');
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText('保存');
  await page.reload();
  await expect(page.locator('#translation-method-source')).toHaveValue('# 我的翻译方法\n先找主干，再处理修饰成分。');
  await expect(page.locator('#translation-revised-text')).toHaveValue('As our studies deepen, we can express ourselves more accurately.');
  await expect(page.locator('#translation-revision-reason')).toHaveValue('随着后面是完整分句，因此选择 as。');
  const back = await inspectHref(page.locator('#back-to-reader'));
  expect(back.searchParams.get('question')).toBe('translation-1');
  expect(back.searchParams.get('page')).toBe('1');
  await page.locator('#back-to-reader').click();
  await expectReturnedPage(page, 1, 'translation-1');
  await expect(answer).toHaveValue('My original translation answer is preserved.');
  expectClean(control);
});

test('UTF-8 method imports are drafts and invalid bytes or NUL cannot replace the current method', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'translation', 1).click();
  const method = '# 我的个人方法\n随着：先判断名词还是分句。';
  await page.locator('#translation-method-file').setInputFiles({ name: '我的方法.md', mimeType: 'text/markdown', buffer: Buffer.from(method, 'utf8') });
  await expect(page.locator('#translation-method-source')).toHaveValue(method);
  expect(await page.evaluate((key) => localStorage.getItem(key), METHOD_KEY)).toBeNull();
  await page.reload();
  await expect(page.locator('#translation-method-source')).toHaveValue(method);
  for (const buffer of [Buffer.from([0xc3, 0x28]), Buffer.from('invalid\0method')]) {
    await page.locator('#translation-method-file').setInputFiles({ name: '坏方法.txt', mimeType: 'text/plain', buffer });
    await expect(page.locator('#translation-status')).toContainText(/UTF-8|NUL|纯文本/);
    await expect(page.locator('#translation-method-source')).toHaveValue(method);
  }
  await page.locator('#save-translation-method').click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), METHOD_KEY)).toBeTruthy();
  expectClean(control);
});

test('personal translation notes stay separate for different unparsed pages', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'translation', 2).click();
  await page.locator('#translation-free-note').fill('只属于第 2 页的句式笔记。');
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText('保存');
  await page.goto(`/translation.html?paper=${PAPER_ID}&page=1`);
  await expect(page.locator('#translation-free-note')).toHaveValue('');
  await page.locator('#translation-free-note').fill('第 1 页的词汇总结。');
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText('保存');
  await page.goto(`/translation.html?paper=${PAPER_ID}&page=2`);
  await expect(page.locator('#translation-free-note')).toHaveValue('只属于第 2 页的句式笔记。');
  expectClean(control);
});

test('method and note HTML stay literal after save and refresh instead of executing', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'translation', 1).click();
  const attack = '<img src=x onerror="window.__translationXss=1"><script>window.__translationXss=2</script>';
  await page.locator('#translation-method-source').fill(attack);
  await page.locator('#save-translation-method').click();
  await page.locator('#translation-source-text').fill(attack);
  await page.locator('#translation-free-note').fill(attack);
  await page.locator('#save-translation-note').click();
  await page.reload();
  await expect(page.locator('#translation-method-source')).toHaveValue(attack);
  await expect(page.locator('#translation-source-text')).toHaveValue(attack);
  await expect(page.locator('#translation-free-note')).toHaveValue(attack);
  await expect(page.locator('img[onerror], script:not([src])')).toHaveCount(0);
  expect(await page.evaluate(() => window.__translationXss)).toBeUndefined();
  expectClean(control);
});

test('a failed personal-note save retains both the previous saved note and the new input', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'translation', 1).click();
  await page.locator('#translation-free-note').fill('以前已保存的笔记。');
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText('保存');
  const saved = await page.evaluate((key) => localStorage.getItem(key), NOTES_KEY);
  await page.locator('#translation-free-note').fill('存储失败也不能丢失的新思路。');
  await page.evaluate((key) => {
    window.__moduleOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === key) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return window.__moduleOriginalSetItem.call(this, storageKey, value);
    };
  }, NOTES_KEY);
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText(/不足|失败|无法/);
  await expect(page.locator('#translation-free-note')).toHaveValue('存储失败也不能丢失的新思路。');
  expect(await page.evaluate((key) => localStorage.getItem(key), NOTES_KEY)).toBe(saved);
  await page.evaluate(() => { Storage.prototype.setItem = window.__moduleOriginalSetItem; });
  await page.locator('#save-translation-note').click();
  await page.reload();
  await expect(page.locator('#translation-free-note')).toHaveValue('存储失败也不能丢失的新思路。');
  expectClean(control);
});

test('a failed translation draft write prevents returning until storage recovers and later restores the draft', async ({ page }) => {
  const control = await setupModules(page, { questions: [] });
  await moduleEntry(page, 'translation', 2).click();
  await page.evaluate(() => {
    window.__moduleOriginalDraftSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cet:translation-note-drafts:v1') throw new DOMException('Synthetic draft quota', 'QuotaExceededError');
      return window.__moduleOriginalDraftSetItem.call(this, key, value);
    };
  });
  await page.locator('#translation-method-source').fill('我的方法草稿：先找主干，再处理修饰语。');
  await page.locator('#translation-free-note').fill('返回试卷之前，这段尚未正式保存的思路不能丢失。');
  await page.locator('#back-to-reader').click();
  await expect(page).toHaveURL(/\/translation\.html\?/);
  await expect(page.locator('#translation-status')).toContainText(/请先保存|保留当前页面/);
  await expect(page.locator('#translation-method-source')).toHaveValue('我的方法草稿：先找主干，再处理修饰语。');
  await expect(page.locator('#translation-free-note')).toHaveValue('返回试卷之前，这段尚未正式保存的思路不能丢失。');
  await page.evaluate(() => { Storage.prototype.setItem = window.__moduleOriginalDraftSetItem; });
  await page.locator('#back-to-reader').click();
  await expectReturnedPage(page, 2);
  await moduleEntry(page, 'translation', 2).click();
  await expect(page.locator('#translation-method-source')).toHaveValue('我的方法草稿：先找主干，再处理修饰语。');
  await expect(page.locator('#translation-free-note')).toHaveValue('返回试卷之前，这段尚未正式保存的思路不能丢失。');
  expect(await page.evaluate((key) => localStorage.getItem(key), METHOD_KEY)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), NOTES_KEY)).toBeNull();
  expectClean(control);
});
