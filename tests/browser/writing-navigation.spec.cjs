const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT, PAPER_ID } = require('./reader-fixture.cjs');

const WRITING_ID = 'writing-2';

function navigationQuestions() {
  return [
    {
      questionId: 'q1', number: 1, type: 'single_choice', page: 1,
      stem: 'Synthetic reading question', confidence: 0.99,
      bbox: { x: 140, y: 220, width: 300, height: 100 },
      options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} synthetic option` })),
    },
    {
      questionId: 'translation-1', number: 61, type: 'translation', page: 1,
      stem: 'Translate the synthetic paragraph.', confidence: 0.99,
      bbox: { x: 140, y: 440, width: 300, height: 120 },
    },
    {
      questionId: WRITING_ID, number: 2, type: 'writing', page: 2,
      stem: 'Write an essay about lifelong learning.', confidence: 0.99,
      bbox: { x: 140, y: 280, width: 300, height: 130 },
    },
  ];
}

async function setupNavigation(page) {
  const control = await setupReader(page, { questions: navigationQuestions() });
  // The shared fixture initially provides one page. Replace that manifest and
  // reload so that returning to page 2 genuinely requires scrolling/locating.
  await page.route(`**${API_ROOT}/manifest`, (route) => route.fulfill({ json: {
    title: 'Synthetic two-page writing navigation paper', pageCount: 2,
    pages: [1, 2].map((number) => ({
      number, width: 595, height: 842, image: `navigation-page-${number}.png`,
      words: (number === 1 ? ['Learning', 'English', 'takes', 'practice.'] : ['Lifelong', 'learning']).map((text, index) => ({
        id: number * 100 + index, text, line: 1, x: 145 + index * 68,
        y: 120, width: 63, height: 20,
      })),
    })),
  } }));
  await page.reload();
  await expect(page.locator('.pdf-page-shell')).toHaveCount(2);
  await expect(page.locator('.pdf-word')).toHaveCount(6);
  await expect(page.locator('#question-navigator button')).toHaveCount(3);
  return control;
}

function expectClean(control) {
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.requests).toEqual([]);
}

async function expectContextLink(link, target, paper = PAPER_ID, question = WRITING_ID) {
  const href = await link.evaluate((node) => node.href);
  const url = new URL(href);
  expect(url.pathname).toBe(`/${target}`);
  expect(url.searchParams.get('paper')).toBe(paper);
  expect(url.searchParams.get('question')).toBe(question);
  expect(url.origin).toBe(await link.evaluate(() => location.origin));
}

async function expectWritingRestored(page) {
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator(`[data-navigate-question="${WRITING_ID}"]`)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator(`#question-detail [data-long-answer="${WRITING_ID}"]`)).toBeVisible();
  await expect(page.locator('#current-page')).toHaveValue('2');
  // Verify the actual original page, not only a page-number label, is onscreen.
  await expect.poll(async () => {
    const viewport = await page.locator('#document-viewport').boundingBox();
    const original = await page.locator('.pdf-page-shell[data-page="2"] .pdf-page-surface').boundingBox();
    return Boolean(viewport && original && original.y < viewport.y + viewport.height && original.y + original.height > viewport.y);
  }).toBe(true);
}

for (const [name, size] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  test(`${name}: the visible writing rail opens templates and returns to the current page-2 essay`, async ({ page }) => {
    await page.setViewportSize(size);
    const control = await setupNavigation(page);
    const number = page.locator(`[data-toggle-page-question="${WRITING_ID}"]`);
    await expect(number).toHaveAttribute('aria-expanded', 'false');
    const entry = page.locator(`a[data-open-writing-template="${WRITING_ID}"]`);
    await expect(entry).toBeVisible();
    await expectContextLink(entry, 'writing.html');
    await entry.scrollIntoViewIfNeeded();
    const linkBox = await entry.boundingBox();
    const original = await page.locator('.pdf-page-shell[data-page="2"] .pdf-page-surface').boundingBox();
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(original.x + 1);
    await entry.click();
    await expect(page).toHaveURL(/\/writing\.html\?/);
    await expect(page.locator('#writing-paragraph-intro')).toBeVisible();
    const back = page.locator('#back-to-reader');
    await expect(back).toBeVisible();
    await expectContextLink(back, 'reader.html');
    await back.click();
    await expectWritingRestored(page);
    if (name === 'mobile') {
      await expect(page.locator('#exam-viewer')).toHaveClass(/is-question-panel-open/);
      await expect(page.locator('#toggle-question-panel')).toHaveAttribute('aria-expanded', 'true');
    } else {
      const viewport = await page.locator('#document-viewport').boundingBox();
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
      await page.mouse.wheel(0, -6000);
      await expect(page.locator('#current-page')).toHaveValue('1');
      await page.mouse.wheel(0, 6000);
      await expect(page.locator('#current-page')).toHaveValue('2');
    }
    expectClean(control);
  });
}

test('reading and translation questions never receive the writing-only rail entry', async ({ page }) => {
  const control = await setupNavigation(page);
  await expect(page.locator('a[data-open-writing-template]')).toHaveCount(1);
  await expect(page.locator('[data-question-id="q1"] a[data-open-writing-template]')).toHaveCount(0);
  await expect(page.locator('[data-question-id="translation-1"] a[data-open-writing-template]')).toHaveCount(0);
  await expect(page.locator(`a[data-open-writing-template="${WRITING_ID}"]`)).toBeVisible();
  expectClean(control);
});

test('returning after saving a personal template preserves the existing essay and PDF note', async ({ page }) => {
  const control = await setupNavigation(page);
  await page.evaluate(() => {
    const words = [...document.querySelectorAll('.pdf-word[data-page="1"]')];
    const range = document.createRange();
    range.setStart(words[0].firstChild, 0);
    range.setEnd(words.at(-1).firstChild, words.at(-1).textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const box = words[0].getBoundingClientRect();
    words[0].dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerType: 'mouse', clientX: box.x + 4, clientY: box.y + 4,
    }));
  });
  await page.locator('[data-selection-action="note"]').click();
  await page.locator('#tag-note').fill('这条笔记必须在模板库往返后保留。');
  await page.locator('#save-tag').click();
  await expect(page.locator('.tag-record-note')).toHaveText('这条笔记必须在模板库往返后保留。');
  await page.locator(`[data-navigate-question="${WRITING_ID}"]`).click();
  const essay = page.locator(`[data-long-answer="${WRITING_ID}"]`);
  await essay.fill('This original essay must not be replaced by visiting the template library.');
  const manage = page.locator('#question-detail .writing-template-library-controls a[href^="writing.html"]');
  await expectContextLink(manage, 'writing.html');
  await manage.click();
  await page.locator('#writing-mode-full').click();
  await page.locator('#template-name').fill('刚为这道作文保存的框架');
  await page.locator('#template-source').fill('In my view, {{观点}}.');
  await page.locator('#slot-fields [data-slot-name="观点"]').fill('learning matters');
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText('保存');
  const saved = await page.evaluate(() => window.WritingTemplates.list()[0]);
  await expectContextLink(page.locator('#back-to-reader'), 'reader.html');
  await page.locator('#back-to-reader').click();
  await expectWritingRestored(page);
  await expect(essay).toHaveValue('This original essay must not be replaced by visiting the template library.');
  await expect(page.locator('.tag-record-note')).toHaveText('这条笔记必须在模板库往返后保留。');
  await expect(page.locator(`[data-writing-library-select] option[value="${saved.id}"]`)).toHaveText('刚为这道作文保存的框架');
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).slots[0].value, saved.id)).toBe('learning matters');
  expectClean(control);
});

test('unknown and malformed question deep links are ignored without changing the available questions', async ({ page }) => {
  const control = await setupNavigation(page);
  for (const question of ['missing-question', 'writing-999', 'writing-2"><img src=x onerror="window.__navigationXss=1">', 'https://evil.invalid/']) {
    await page.goto(`/reader.html?paper=${PAPER_ID}&question=${encodeURIComponent(question)}`);
    await expect(page.locator('.pdf-page-shell')).toHaveCount(2);
    await expect(page.locator('#question-navigator button')).toHaveCount(3);
    await expect(page.locator('[data-navigate-question="q1"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#question-detail')).toContainText('Synthetic reading question');
    await expect(page.locator('img[onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__navigationXss)).toBeUndefined();
  }
  expectClean(control);
});

test('a failed answer save prevents entering the template library and retains the editable essay', async ({ page }) => {
  const control = await setupNavigation(page);
  await page.locator(`[data-navigate-question="${WRITING_ID}"]`).click();
  const essay = page.locator(`[data-long-answer="${WRITING_ID}"]`);
  await essay.fill('This unsaved essay must remain editable when storage is full.');
  await page.evaluate((paper) => {
    window.__navigationOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === `exam-viewer:${paper}:v1`) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return window.__navigationOriginalSetItem.call(this, key, value);
    };
  }, PAPER_ID);
  const entry = page.locator(`.page-module-entry-layer a[data-open-writing-template="${WRITING_ID}"]`);
  await entry.click();
  await expect(page).toHaveURL(/\/reader\.html\?/);
  await expect(page.locator('#viewer-toast')).toContainText(/暂停跳转|尚未保存/);
  await expect(essay).toHaveValue('This unsaved essay must remain editable when storage is full.');
  await page.evaluate(() => { Storage.prototype.setItem = window.__navigationOriginalSetItem; });
  await entry.click();
  await expect(page).toHaveURL(/\/writing\.html\?/);
  await page.locator('#back-to-reader').click();
  await expectWritingRestored(page);
  await expect(essay).toHaveValue('This unsaved essay must remain editable when storage is full.');
  expectClean(control);
});

test('template return links cannot turn invalid paper or question parameters into external navigation', async ({ page }) => {
  const control = await setupNavigation(page);
  for (const paper of ['https://evil.invalid/', '../outside', 'browser-fixture&question=writing-2']) {
    await page.goto(`/writing.html?paper=${encodeURIComponent(paper)}&question=${WRITING_ID}`);
    await expect(page.locator('#writing-paragraph-intro')).toBeVisible();
    await expect(page.locator('#back-to-reader')).toBeHidden();
  }
  for (const question of ['javascript:alert(1)', '../outside', 'writing-2" onclick="alert(1)']) {
    await page.goto(`/writing.html?paper=${PAPER_ID}&question=${encodeURIComponent(question)}`);
    const back = page.locator('#back-to-reader');
    await expect(back).toBeVisible();
    const href = new URL(await back.evaluate((node) => node.href));
    expect(href.origin).toBe(new URL(page.url()).origin);
    expect(href.pathname).toBe('/reader.html');
    expect(href.searchParams.get('paper')).toBe(PAPER_ID);
    expect(href.searchParams.get('question')).toBeNull();
    await expect(back).not.toHaveAttribute('onclick', /./);
  }
  expectClean(control);
});
