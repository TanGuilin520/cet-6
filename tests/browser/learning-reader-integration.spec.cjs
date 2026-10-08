const { test, expect } = require('@playwright/test');
const { setupReader, selectPdfWords, PAPER_ID } = require('./reader-fixture.cjs');
const KEY = `exam-viewer:${PAPER_ID}:v1`;

test('a PDF selection is explicitly collected with its page and reused in the learning journal', async ({ page }) => {
  const control = await setupReader(page);
  const text = await selectPdfWords(page);
  await page.locator('[data-selection-action="expression"]').click();
  await expect(page.locator('dialog.learning-capture')).toBeVisible();
  await expect(page.locator('[data-expression-text]')).toHaveValue(text);
  await page.locator('[data-save-expression]').click();
  await expect(page.locator('dialog.learning-capture')).toHaveCount(0);
  const entry = await page.evaluate(() => JSON.parse(localStorage.getItem('cet:expression-library:v1')).entries[0]);
  expect(entry.context).toEqual({ paper: PAPER_ID, question: '', page: 1, module: 'reader' });
  await page.goto('/learning.html?type=expression');
  await expect(page.locator('#learning-records')).toContainText(text);
  expect(control.requests).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('journal note links return to the original page and open exactly that PDF note', async ({ page }) => {
  const control = await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="note"]').click();
  await page.locator('#tag-label').fill('句型');
  await page.locator('#tag-note').fill('Learning takes sustained practice.');
  await page.locator('#save-tag').click();
  await page.goto('/learning.html');
  const link = page.locator('[data-learning-record^="reader:"] a').first();
  await expect(link).toHaveAttribute('href', /note=/);
  await link.click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#tag-note')).toHaveValue('Learning takes sustained practice.');
  await expect(page.locator('#current-page')).toHaveValue('1');
  expect(control.pageErrors).toEqual([]);
});

test('an already-open reader receives workspace answers and never overwrites them on a later zoom save', async ({ page }) => {
  const control = await setupReader(page);
  const workspace = await page.context().newPage();
  await workspace.goto('/learning.html');
  await workspace.evaluate((paper) => window.LearningStore.applyAnswer({ paper, question: 'q1', answer: 'C', expectedAnswer: '' }), PAPER_ID);
  await expect(page.locator('#answered-count')).toHaveText('1');
  await page.locator('#zoom-in').click();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers.q1, KEY)).toBe('C');
  await workspace.evaluate((paper) => window.LearningStore.applyAnswer({ paper, question: 'q2', answer: 'B', expectedAnswer: '' }), PAPER_ID);
  await expect(page.locator('#answered-count')).toHaveText('2');
  await page.locator('#zoom-out').click();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers, KEY)).toEqual({ q1: 'C', q2: 'B' });
  expect(control.pageErrors).toEqual([]);
});

test('fresh storage merging protects answers even before a suspended tab receives its storage event', async ({ page }) => {
  await setupReader(page);
  await page.evaluate((paper) => window.LearningStore.applyAnswer({ paper, question: 'q2', answer: 'D', expectedAnswer: '' }), PAPER_ID);
  await page.locator('#zoom-in').click();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers.q2, KEY)).toBe('D');
  await page.reload();
  await expect(page.locator('#answered-count')).toHaveText('1');
});

test('a concurrent long-answer change pauses saving until the learner explicitly resolves the conflict', async ({ page }) => {
  const control = await setupReader(page, { questions: [{
    questionId: 'writing-1', number: 1, type: 'writing', page: 1, confidence: 0.99,
    stem: 'Write about daily learning.', bbox: { x: 90, y: 120, width: 420, height: 190 },
  }] });
  await page.evaluate((paper) => {
    const input = document.querySelector('[data-long-answer="writing-1"]');
    input.value = 'My unsaved local draft.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.LearningStore.applyAnswer({ paper, question: 'writing-1', answer: 'Another workspace draft.', expectedAnswer: '' });
  }, PAPER_ID);
  await expect(page.locator('#answer-sync-conflict')).toBeVisible();
  await expect(page.locator('[data-long-answer]')).toHaveValue('My unsaved local draft.');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['writing-1'], KEY)).toBe('Another workspace draft.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#answer-conflict-use-current').click();
  await expect(page.locator('#answer-sync-conflict')).toBeHidden();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['writing-1'], KEY)).toBe('My unsaved local draft.');
  expect(control.pageErrors).toEqual([]);
});

test('a damaged exam record is never overwritten by a reader autosave', async ({ page }) => {
  await setupReader(page);
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), KEY);
  await page.locator('#zoom-in').click();
  await expect(page.locator('#save-indicator')).toHaveClass(/is-error/);
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('{broken');
});

test('expressions can be edited in the journal without changing their ID or source position', async ({ page }) => {
  await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="expression"]').click();
  await page.locator('[data-save-expression]').click();
  const original = await page.evaluate(() => window.LearningStore.expressions()[0]);
  await page.goto('/learning.html?type=expression');
  await page.getByRole('button', { name: '编辑表达', exact: true }).click();
  await page.locator('[data-expression-text]').fill('Practice makes progress.');
  await page.locator('[data-save-expression]').click();
  const edited = await page.evaluate(() => window.LearningStore.expressions()[0]);
  expect(edited.id).toBe(original.id);
  expect(edited.context).toEqual(original.context);
  expect(edited.text).toBe('Practice makes progress.');
  await expect(page.locator('#learning-records')).toContainText('Practice makes progress.');
});
