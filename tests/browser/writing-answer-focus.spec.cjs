const { test, expect } = require('@playwright/test');

const PAPER = 'writing-answer-fixture';
const OTHER = 'writing-answer-other';
const QUESTION = 'writing-1';
const EXAM_KEY = `exam-viewer:${PAPER}:v1`;
const DRAFT_KEY = 'cet:writing-answers:v1';
const LIBRARY_KEY = 'cet:writing-template-library:v1';
const INTRO = '#writing-paragraph-intro';
const TASK = 'Directions: Write an essay about learning from experience. You should write at least 120 words but no more than 180 words.';

async function install(page, { seed, quota = false } = {}) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/reader.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture reader</title><p>Returned to paper</p>' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (/\/questions$/.test(url.pathname)) return route.fulfill({ json: { revision: 1, questions: [
      { questionId: QUESTION, type: 'writing', page: 1, stem: TASK, bbox: { x: 20, y: 20, width: 200, height: 80 }, confidence: .99 },
      { questionId: 'writing-2', type: 'writing', page: 2, stem: 'Directions: Write about reading widely.', bbox: { x: 20, y: 20, width: 200, height: 80 }, confidence: .99 },
    ] } });
    if (/\/manifest$/.test(url.pathname)) return route.fulfill({ json: { title: 'Writing fixture', pages: [
      { number: 1, width: 595, height: 842, words: [
        { text: 'Writing', x: 30, y: 30, width: 90, height: 12 },
        { text: TASK, x: 30, y: 60, width: 300, height: 12 },
      ] }, { number: 2, width: 595, height: 842, words: [] },
    ] } });
    return route.fulfill({ status: 404, json: { error: 'No real AI or external API allowed' } });
  });
  if (seed || quota) await page.addInitScript(({ seed, quota, examKey }) => {
    if (seed && localStorage.getItem(examKey) === null) localStorage.setItem(examKey, JSON.stringify(seed));
    if (quota) {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === examKey) throw new DOMException('Synthetic quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    }
  }, { seed, quota, examKey: EXAM_KEY });
  return errors;
}
async function open(page, { paper = PAPER, question = QUESTION, pageNumber = 1 } = {}) {
  const params = new URLSearchParams({ paper, page: String(pageNumber) });
  if (question) params.set('question', question);
  await page.goto(`/writing.html?${params}`);
  await expect(page.locator(INTRO)).toBeVisible();
  await expect(page.locator('#writing-task-state')).not.toContainText('正在');
}
async function stored(page, key) { return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), key); }
async function waitDraft(page, paper = PAPER, question = QUESTION) {
  await expect.poll(async () => (await stored(page, DRAFT_KEY))?.entries?.find((entry) => entry.contextKey === `${paper}:${question}`)?.source).toBeTruthy();
}

test('paper-specific answers stay separate from the reusable template draft and other questions', async ({ page }) => {
  const errors = await install(page);
  await page.addInitScript(() => localStorage.setItem('cet:writing-template-draft:v1', JSON.stringify({ activeKey: 'old-template', entries: [{ key: 'old-template', id: null, name: 'My reusable draft', source: 'Reusable template.', slots: [] }] })));
  await open(page);
  await expect(page.locator('#writing-scope-answer')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(INTRO)).toHaveValue('');
  await page.locator(INTRO).fill('Only this paper.');
  await waitDraft(page);
  expect((await stored(page, DRAFT_KEY)).entries.find((entry) => entry.contextKey === `${PAPER}:${QUESTION}`).prompt).toBe(TASK);
  await page.locator('#writing-scope-template').click();
  await expect(page.locator(INTRO)).toHaveValue('Reusable template.');
  await page.locator('#writing-scope-answer').click();
  await expect(page.locator(INTRO)).toHaveValue('Only this paper.');
  await open(page, { paper: OTHER });
  await expect(page.locator(INTRO)).toHaveValue('');
  await page.locator(INTRO).fill('Another paper.');
  await waitDraft(page, OTHER);
  await open(page, { question: 'writing-2', pageNumber: 2 });
  await expect(page.locator(INTRO)).toHaveValue('');
  await open(page);
  await expect(page.locator(INTRO)).toHaveValue('Only this paper.');
  expect((await stored(page, DRAFT_KEY)).entries).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('templates are copied into an answer; editing and separately saving never mutate the original', async ({ page }) => {
  await install(page); await open(page);
  const id = await page.evaluate(() => window.WritingTemplates.save({ name: 'Original', source: 'Learning {{topic}}.', slots: [{ name: 'topic', value: 'English', type: 'word' }] }).id);
  await page.reload();
  await page.locator(`[data-template-id="${id}"]`).click();
  await expect(page.locator(INTRO)).toHaveValue('Learning {{topic}}.');
  await page.locator(INTRO).fill('My own introduction.');
  await page.locator('#template-name').fill('Separate copy');
  await page.locator('#save-template').click();
  const library = await stored(page, LIBRARY_KEY);
  expect(library.find((record) => record.id === id).source).toBe('Learning {{topic}}.');
  expect(library.find((record) => record.name === 'Separate copy').source).toBe('My own introduction.');
  await expect(page.locator('#writing-scope-answer')).toHaveAttribute('aria-pressed', 'true');
  expect(await stored(page, EXAM_KEY)).toBeNull();
});

test('switching to templates during task loading does not lose the previously saved exam answer', async ({ page }) => {
  await install(page, { seed: { answers: { [QUESTION]: 'Previously saved essay.' }, annotations: [] } });
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/exams/${PAPER}/questions`, async (route) => {
    await ready;
    return route.fulfill({ json: { revision: 1, questions: [{ questionId: QUESTION, type: 'writing', page: 1, stem: TASK }] } });
  });
  await page.goto(`/writing.html?paper=${PAPER}&question=${QUESTION}&page=1`);
  await page.locator('#writing-scope-template').click();
  release();
  await expect(page.locator('#writing-task-state')).not.toContainText('正在');
  await expect(page.locator(INTRO)).toHaveValue('');
  await page.locator('#writing-scope-answer').click();
  await expect(page.locator(INTRO)).toHaveValue('Previously saved essay.');
});

test('applying a preview confirms overwrite and merges only the target answer', async ({ page }) => {
  const annotation = { id: 'note-1', type: 'tag', page: 1, label: '重点', note: 'Preserve me', rects: [{ x: 20, y: 30, width: 80, height: 15 }] };
  await install(page, { seed: { answers: { [QUESTION]: 'Previous essay.', q2: 'C' }, annotations: [annotation], submitted: true, grade: { correct: 1 }, zoom: 1.2, aiHistory: {} } });
  await open(page);
  await expect(page.locator(INTRO)).toHaveValue('Previous essay.');
  await page.locator(INTRO).fill('An introduction.');
  await page.locator('#writing-paragraph-body').fill('A developed argument.');
  await page.locator('#writing-paragraph-conclusion').fill('A conclusion.');
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-apply-preview')).toHaveText('An introduction.\n\nA developed argument.\n\nA conclusion.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#writing-apply-confirm').click();
  expect((await stored(page, EXAM_KEY)).answers[QUESTION]).toBe('Previous essay.');
  await expect(page).toHaveURL(/writing\.html/);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#writing-apply-confirm').click();
  await expect(page).toHaveURL(/reader\.html\?.*question=writing-1/);
  const saved = await stored(page, EXAM_KEY);
  expect(saved.answers).toEqual({ [QUESTION]: 'An introduction.\n\nA developed argument.\n\nA conclusion.', q2: 'C' });
  expect(saved.annotations).toEqual([annotation]);
  expect(saved.zoom).toBe(1.2); expect(saved.submitted).toBe(false); expect(saved.grade).toBeNull();
});

test('page-only and unknown question entries save independent drafts but cannot invent answer IDs', async ({ page }) => {
  await install(page); await open(page, { question: null });
  await page.locator(INTRO).fill('Page-only practice.');
  await page.locator('#writing-save-answer').click();
  expect((await stored(page, DRAFT_KEY)).entries[0].contextKey).toBe(`${PAPER}:page-1`);
  await expect(page.locator('#writing-apply-answer')).toBeDisabled();
  await expect(page.locator('#writing-apply-state')).toContainText('已验证的题号');
  await expect(page.locator('#writing-apply-state a')).toHaveText('前往复核确认作文题');
  await expect(page.locator('#writing-apply-state a')).toHaveAttribute('href', `review.html?exam=${PAPER}`);
  expect(await stored(page, EXAM_KEY)).toBeNull();
  await open(page, { question: 'writing-99' });
  await page.locator(INTRO).fill('Unknown question practice.');
  await expect(page.locator('#writing-apply-answer')).toBeDisabled();
});

test('unfilled and invalid placeholders are never applied as completed answers', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('Learning {{topic}} is worthwhile.');
  await expect(page.locator('#writing-apply-answer')).toBeDisabled();
  await page.locator('[data-slot-name="topic"]').fill('English');
  await expect(page.locator('#writing-apply-answer')).toBeEnabled();
  await page.locator(INTRO).fill('Learning {{topic is worthwhile.');
  await expect(page.locator('#writing-apply-answer')).toBeDisabled();
  expect(await stored(page, EXAM_KEY)).toBeNull();
});

test('quota failures preserve the draft and do not navigate', async ({ page }) => {
  await install(page, { quota: true }); await open(page);
  await page.locator(INTRO).fill('Keep this essay.');
  await page.locator('#writing-apply-answer').click();
  await page.locator('#writing-apply-confirm').click();
  await expect(page.locator('#writing-apply-warning')).toContainText('保存失败');
  await expect(page).toHaveURL(/writing\.html/);
  await expect(page.locator(INTRO)).toHaveValue('Keep this essay.');
  expect((await stored(page, DRAFT_KEY)).entries[0].source).toBe('Keep this essay.');
  expect(await stored(page, EXAM_KEY)).toBeNull();
});

test('corrupt exam data is not overwritten or used to navigate', async ({ page }) => {
  await install(page);
  await page.addInitScript((key) => localStorage.setItem(key, '{invalid json'), EXAM_KEY);
  await open(page); await page.locator(INTRO).fill('Keep my input.');
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-status')).toContainText('无法读取');
  await expect(page.locator('#writing-apply-dialog')).not.toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), EXAM_KEY)).toBe('{invalid json');
  await expect(page.locator(INTRO)).toHaveValue('Keep my input.');
});

test('a changed answer after preview must be previewed again rather than overwritten', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('Local essay.');
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-apply-dialog')).toBeVisible();
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ answers: { 'writing-1': 'Newer essay.', q2: 'D' }, annotations: [] })), EXAM_KEY);
  await page.locator('#writing-apply-confirm').click();
  await expect(page.locator('#writing-apply-warning')).toContainText('另一个窗口修改');
  expect((await stored(page, EXAM_KEY)).answers[QUESTION]).toBe('Newer essay.');
  await expect(page).toHaveURL(/writing\.html/);
});

test('a task changed since initial loading is rejected before opening the application preview', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('Written for the original task.');
  await page.route(`**/api/exams/${PAPER}/questions`, (route) => route.fulfill({ json: { revision: 2, questions: [
    { questionId: QUESTION, type: 'writing', page: 1, stem: 'Directions: Write about a different subject.' },
  ] } }));
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-status')).toContainText('版本已变化');
  await expect(page.locator('#writing-apply-dialog')).not.toBeVisible();
  expect(await stored(page, EXAM_KEY)).toBeNull();
});

test('a question removed or reclassified after preview cannot receive an essay answer', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('Keep this essay draft.');
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-apply-dialog')).toBeVisible();
  await page.route(`**/api/exams/${PAPER}/questions`, (route) => route.fulfill({ json: { revision: 2, questions: [
    { questionId: QUESTION, type: 'translation', page: 1, stem: 'Now translate this source.' },
  ] } }));
  await page.locator('#writing-apply-confirm').click();
  await expect(page.locator('#writing-apply-warning')).toContainText('改为其它题型');
  await expect(page.locator(INTRO)).toHaveValue('Keep this essay draft.');
  expect(await stored(page, EXAM_KEY)).toBeNull();
  await expect(page).toHaveURL(/writing\.html/);
});

test('a changed revision after preview requires a fresh review even if this task text is unchanged', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('Keep this revision-sensitive draft.');
  await page.locator('#writing-apply-answer').click();
  await expect(page.locator('#writing-apply-dialog')).toBeVisible();
  await page.route(`**/api/exams/${PAPER}/questions`, (route) => route.fulfill({ json: { revision: 2, questions: [
    { questionId: QUESTION, type: 'writing', page: 1, stem: TASK, bbox: { x: 20, y: 20, width: 200, height: 80 }, confidence: .99 },
  ] } }));
  await page.locator('#writing-apply-confirm').click();
  await expect(page.locator('#writing-apply-warning')).toContainText('版本已变化');
  expect(await stored(page, EXAM_KEY)).toBeNull();
});

test('concurrent draft changes and corrupt draft storage are protected', async ({ page }) => {
  await install(page); await open(page);
  await page.locator(INTRO).fill('First saved draft.'); await waitDraft(page);
  await page.locator(INTRO).fill('Unsaved local change.');
  await page.evaluate((key) => {
    const store = JSON.parse(localStorage.getItem(key)); store.entries[0].source = 'Newer external draft.'; store.entries[0].answer = 'Newer external draft.';
    localStorage.setItem(key, JSON.stringify(store));
  }, DRAFT_KEY);
  await page.locator('#writing-save-answer').click();
  await expect(page.locator('#writing-status')).toContainText('另一窗口修改');
  await expect(page.locator(INTRO)).toHaveValue('Unsaved local change.');
  expect((await stored(page, DRAFT_KEY)).entries[0].source).toBe('Newer external draft.');
  await expect(page.locator('#writing-reload-answer')).toBeVisible();
  await page.locator('#export-template').click();
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), DRAFT_KEY);
  await page.reload();
  await page.locator(INTRO).fill('Recoverable current input.');
  await page.locator('#writing-save-answer').click();
  await expect(page.locator('#writing-status')).toContainText('停止覆盖');
  expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBe('{broken');
});

test('focus mode, collapsible task and mobile tabs keep fixed answer actions accessible', async ({ page }) => {
  await install(page); await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await expect(page.locator('.library-panel')).not.toBeVisible();
  await page.locator('#writing-toggle-task').click();
  await expect(page.locator('#writing-task-prompt')).not.toBeVisible();
  await page.locator('#writing-toggle-task').click();
  await expect(page.locator('#writing-task-prompt')).toBeVisible();
  await page.locator('#writing-focus-mode').click();
  await expect(page.locator('.writing-intro')).not.toBeVisible();
  await page.locator(INTRO).fill('A mobile essay.');
  await page.locator('[data-writing-tab="methods"]').click();
  await expect(page.locator('.library-panel')).toBeVisible();
  await expect(page.locator(INTRO)).not.toBeVisible();
  await expect(page.locator('#writing-save-answer')).toBeVisible();
  await page.locator('[data-writing-tab="preview"]').click();
  await expect(page.locator('#writing-paragraph-preview')).toContainText('A mobile essay.');
  await expect(page.locator('#writing-apply-answer')).toBeVisible();
  await page.locator('[data-writing-tab="answer"]').click();
  await expect(page.locator(INTRO)).toHaveValue('A mobile essay.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
