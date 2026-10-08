const { test, expect } = require('@playwright/test');

const PAPER = 'writing-workspace-fixture';
const OTHER_PAPER = 'writing-workspace-other';
const QUESTION = 'writing-1';
const LIBRARY_KEY = 'cet:writing-template-library:v1';
const DRAFT_KEY = 'cet:writing-template-draft:v1';
const TASK = 'Directions: For this part, you are allowed 30 minutes to write an essay that begins with the sentence "Education creates opportunities for everyone." You should write at least 150 words but no more than 200 words.';
const OTHER_TASK = 'Directions: Write an essay about balancing study and exercise. You should write at least 120 words but no more than 180 words.';
const INTRO = '#writing-paragraph-intro';
const BODY = '#writing-paragraph-body';
const CONCLUSION = '#writing-paragraph-conclusion';

function writingQuestion(stem = TASK, id = QUESTION) {
  return {
    questionId: id, number: 1, type: 'writing', page: 1,
    stem, confidence: 0.99,
    bbox: { x: 40, y: 95, width: 510, height: 150 },
  };
}

function writingWords() {
  // These three extracted line IDs share the same visual heading row, just
  // like the uploaded paper. Directions end before Part II, not at the footer.
  const words = [
    { text: 'Part', line: 1, x: 42, y: 95, width: 25, height: 13 },
    { text: 'I', line: 1, x: 72, y: 95, width: 5, height: 13 },
    { text: 'Writing', line: 2, x: 265, y: 95, width: 45, height: 13 },
    { text: '(30', line: 3, x: 485, y: 95, width: 20, height: 13 },
    { text: 'minutes)', line: 3, x: 510, y: 95, width: 42, height: 13 },
    { text: 'Directions:', line: 4, x: 42, y: 116, width: 60, height: 13 },
    { text: 'For this part, you are allowed 30 minutes to write an essay', line: 4, x: 108, y: 116, width: 440, height: 13 },
    { text: 'that begins with the sentence "Education creates opportunities for everyone."', line: 5, x: 42, y: 137, width: 510, height: 13 },
    { text: 'You should write at least 150 words but no more than 200 words.', line: 6, x: 42, y: 158, width: 500, height: 13 },
    { text: 'Part', line: 7, x: 42, y: 200, width: 25, height: 13 },
    { text: 'II', line: 7, x: 72, y: 200, width: 10, height: 13 },
    { text: 'Listening Comprehension', line: 8, x: 265, y: 200, width: 190, height: 13 },
    { text: 'Directions: Listen to the synthetic recording.', line: 9, x: 42, y: 225, width: 500, height: 13 },
    { text: '1 https://example.invalid/footer', line: 10, x: 42, y: 810, width: 510, height: 13 },
  ];
  return words.map((word, index) => ({ id: index + 1, ...word }));
}

function paperManifest(words = writingWords(), title = 'Synthetic writing workspace paper') {
  return {
    title, pageCount: 1,
    pages: [{ number: 1, width: 595, height: 842, image: 'writing-workspace.png', words }],
  };
}

async function installWorkspace(page, {
  questions = [writingQuestion()], words = writingWords(),
  title = 'Synthetic writing workspace paper', waitForQuestions,
} = {}) {
  const control = { outsideRequests: [], pageErrors: [], reads: [], forbiddenRequests: [] };
  page.on('pageerror', (error) => control.pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      control.outsideRequests.push(url.href);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    control.reads.push({ method: request.method(), path: url.pathname });
    const isOther = url.pathname.startsWith(`/api/exams/${OTHER_PAPER}/`);
    if (request.method() === 'GET' && /^\/api\/exams\/writing-workspace-(?:fixture|other)\/questions$/.test(url.pathname)) {
      if (waitForQuestions && !isOther) await waitForQuestions;
      return route.fulfill({ json: { revision: 1, questions: isOther ? [writingQuestion(OTHER_TASK)] : questions } });
    }
    if (request.method() === 'GET' && /^\/api\/exams\/writing-workspace-(?:fixture|other)\/manifest$/.test(url.pathname)) {
      return route.fulfill({ json: paperManifest(words, isOther ? 'Another synthetic writing paper' : title) });
    }
    // No answer PDF, AI model, or other actual API can be used by these tests.
    control.forbiddenRequests.push({ method: request.method(), path: url.pathname });
    return route.fulfill({ status: 404, json: { error: 'No real API in writing workspace tests' } });
  });
  return control;
}

async function openWorkspace(page, { paper = PAPER, question = QUESTION, pageNumber = 1 } = {}) {
  const params = new URLSearchParams({ paper, page: String(pageNumber) });
  if (question !== null) params.set('question', question);
  await page.goto(`/writing.html?${params}`);
  // These regression cases exercise the reusable template editor explicitly;
  // paper entries now intentionally default to a separate exam-answer draft.
  await page.locator('#writing-scope-template').click();
  await expect(page.locator(INTRO)).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.WritingTemplates?.save)).toBe('function');
}

function assertClean(control) {
  expect(control.outsideRequests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
  expect(control.forbiddenRequests).toEqual([]);
  expect(control.reads.every((request) => request.method === 'GET')).toBe(true);
}

async function seedDraft(page, { name = '此前的个人模板', source, slots = [] }) {
  await page.addInitScript(({ key, record }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      activeKey: record.key, entries: [record],
    }));
  }, {
    key: DRAFT_KEY,
    record: { key: 'synthetic-draft', id: null, name, source, slots, updatedAt: '2026-10-08T00:00:00Z' },
  });
}

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  test(`${name}: the carried-over task stays visible above a responsive three-paragraph editor`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const control = await installWorkspace(page);
    await openWorkspace(page);
    await expect(page.locator('#writing-task-prompt')).toBeVisible();
    await expect(page.locator('#writing-task-prompt')).toContainText('Education creates opportunities for everyone.');
    await expect(page.locator('#writing-task-word-limit')).toContainText(/150[\s\S]*200/);
    await expect(page.locator('#writing-task-context')).toContainText('Synthetic writing workspace paper');
    await expect(page.locator(INTRO)).toBeVisible();
    await expect(page.locator(BODY)).toBeVisible();
    await expect(page.locator(CONCLUSION)).toBeVisible();
    await expect(page.locator('#writing-full-editor')).toBeHidden();
    await expect(page.locator('#template-source')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    const taskBox = await page.locator('#writing-task-prompt').boundingBox();
    const editorBox = await page.locator(INTRO).boundingBox();
    expect(taskBox.y).toBeLessThan(editorBox.y);
    const returnUrl = new URL(await page.locator('#back-to-reader').evaluate((link) => link.href));
    expect(returnUrl.pathname).toBe('/reader.html');
    expect(returnUrl.searchParams.get('paper')).toBe(PAPER);
    expect(returnUrl.searchParams.get('question')).toBe(QUESTION);
    expect(returnUrl.searchParams.get('page')).toBe('1');
    assertClean(control);
  });
}

test('the requested writing question is chosen precisely instead of the first question or an answer resource', async ({ page }) => {
  const control = await installWorkspace(page, { questions: [
    writingQuestion('Write an essay about an unrelated question.', 'writing-unrelated'),
    writingQuestion(TASK),
  ] });
  await openWorkspace(page);
  await expect(page.locator('#writing-task-prompt')).toContainText('Education creates opportunities for everyone.');
  await expect(page.locator('#writing-task-prompt')).not.toContainText('unrelated');
  await expect(page.locator('#template-source')).toHaveValue('');
  assertClean(control);
});

test('page-only entry reconstructs the task from split-line Writing coordinates and stops before Listening', async ({ page }) => {
  const control = await installWorkspace(page, { questions: [] });
  await openWorkspace(page, { question: null });
  await expect(page.locator('#writing-task-prompt')).toContainText('Education creates opportunities for everyone.');
  await expect(page.locator('#writing-task-prompt')).toContainText('150 words');
  await expect(page.locator('#writing-task-prompt')).not.toContainText(/Listen|footer|example\.invalid/);
  await expect(page.locator('#writing-task-word-limit')).toContainText(/150[\s\S]*200/);
  const back = new URL(await page.locator('#back-to-reader').evaluate((link) => link.href));
  expect(back.searchParams.get('question')).toBeNull();
  assertClean(control);
});

test('unknown or non-writing question IDs never borrow another task on the same page', async ({ page }) => {
  const control = await installWorkspace(page, { questions: [
    writingQuestion(), { ...writingQuestion('Translate this unrelated source.', 'translation-1'), type: 'translation' },
  ] });
  for (const question of ['missing-writing', 'translation-1']) {
    await openWorkspace(page, { question });
    await expect(page.locator('#writing-task-state')).toContainText(/未找到|不能|无法|不是|不存在/);
    await expect(page.locator('#writing-task-prompt')).not.toContainText('Education creates opportunities for everyone.');
    await expect(page.locator('#writing-task-prompt')).not.toContainText('Translate this unrelated source.');
    await expect(page.locator('#template-source')).toHaveValue('');
  }
  assertClean(control);
});

test('an image-only paper or prose mention of Writing does not generate an invented essay task', async ({ page }) => {
  const control = await installWorkspace(page, { questions: [], words: [] });
  await openWorkspace(page, { question: null });
  await expect(page.locator('#writing-task-state')).toContainText(/未找到|暂无|无法|手动|没有/);
  await expect(page.locator('#writing-task-prompt')).not.toContainText('Education creates opportunities for everyone.');
  await page.locator(INTRO).fill('My own opening paragraph.');
  await expect(page.locator('#template-source')).toHaveValue('My own opening paragraph.');
  await page.route(`**/api/exams/${PAPER}/manifest`, (route) => route.fulfill({ json: paperManifest([
    { id: 1, text: 'Writing English requires practice.', line: 1, x: 42, y: 95, width: 400, height: 13 },
    { id: 2, text: 'This passage is not an exam instruction.', line: 2, x: 42, y: 120, width: 400, height: 13 },
  ]) }));
  await page.reload();
  await page.locator('#writing-scope-template').click();
  await expect(page.locator('#writing-task-state')).toContainText(/未找到|暂无|无法|手动|没有/);
  await expect(page.locator('#writing-task-prompt')).not.toContainText('Writing English requires practice.');
  await expect(page.locator(INTRO)).toHaveValue('My own opening paragraph.');
  assertClean(control);
});

test('three paragraphs keep blank-line boundaries across mode switching, draft reload and library saving', async ({ page }) => {
  const control = await installWorkspace(page);
  await openWorkspace(page);
  const paragraphs = ['In my view, education creates opportunities.', 'For example, daily practice builds confidence.', 'In conclusion, everyone should keep learning.'];
  await page.locator('#template-name').fill('我的三段议论文');
  for (const [selector, value] of [[INTRO, paragraphs[0]], [BODY, paragraphs[1]], [CONCLUSION, paragraphs[2]]]) {
    await page.locator(selector).fill(value);
  }
  const source = paragraphs.join('\n\n');
  await expect(page.locator('#template-source')).toHaveValue(source);
  await expect(page.locator('#template-preview')).toHaveText(source);
  await page.locator('#writing-mode-full').click();
  await expect(page.locator('#template-source')).toBeVisible();
  await expect(page.locator('#template-source')).toHaveValue(source);
  await page.locator('#writing-mode-paragraphs').click();
  await expect(page.locator(CONCLUSION)).toHaveValue(paragraphs[2]);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBeTruthy();
  await page.reload();
  await page.locator('#writing-scope-template').click();
  for (const [selector, value] of [[INTRO, paragraphs[0]], [BODY, paragraphs[1]], [CONCLUSION, paragraphs[2]]]) {
    await expect(page.locator(selector)).toHaveValue(value);
  }
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText('保存');
  const [saved] = await page.evaluate(() => window.WritingTemplates.list());
  expect(saved.source).toBe(source);
  expect(saved).not.toHaveProperty('questionId');
  expect(saved.source).not.toContain('Education creates opportunities for everyone.');
  await page.reload();
  await page.locator('#writing-scope-template').click();
  await expect(page.locator(BODY)).toHaveValue(paragraphs[1]);
  assertClean(control);
});

test('word and sentence slots insert at the last-focused paragraph and retain their values after refresh', async ({ page }) => {
  const control = await installWorkspace(page);
  await openWorkspace(page);
  await page.locator('#template-name').fill('分段填空');
  await page.locator(INTRO).fill('Today, ');
  await page.locator(INTRO).evaluate((input) => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  await page.locator('#slot-name').fill('主题');
  await page.locator('#insert-word-slot').click();
  await expect(page.locator(INTRO)).toHaveValue('Today, {{主题}}');
  await page.locator('#slot-fields input[data-slot-name="主题"]').fill('education');
  await page.locator(BODY).fill('For example, ');
  await page.locator(BODY).evaluate((input) => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  await page.locator('#slot-name').fill('论据');
  await page.locator('#insert-sentence-slot').click();
  await expect(page.locator(BODY)).toHaveValue('For example, {{论据}}');
  await page.locator('#slot-fields textarea[data-slot-name="论据"]').fill('Practice opens new doors.');
  await page.locator(CONCLUSION).fill('In conclusion, {{主题}} matters.');
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(2);
  await expect(page.locator('#template-preview')).toHaveText('Today, education\n\nFor example, Practice opens new doors.\n\nIn conclusion, education matters.');
  await page.locator('#save-template').click();
  await page.reload();
  await page.locator('#writing-scope-template').click();
  await expect(page.locator(INTRO)).toHaveValue('Today, {{主题}}');
  await expect(page.locator(BODY)).toHaveValue('For example, {{论据}}');
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('education');
  await expect(page.locator('#slot-fields [data-slot-name="论据"]')).toHaveValue('Practice opens new doors.');
  assertClean(control);
});

test('a selected phrase in the middle paragraph becomes a slot without changing the other paragraphs', async ({ page }) => {
  const control = await installWorkspace(page);
  await openWorkspace(page);
  await page.locator(INTRO).fill('This is my introduction.');
  await page.locator(BODY).fill('Daily practice builds confidence.');
  await page.locator(CONCLUSION).fill('This is my conclusion.');
  await page.locator(BODY).evaluate((input) => { input.focus(); input.setSelectionRange(6, 14); });
  await page.locator('#slot-name').fill('练习方式');
  await page.locator('#selection-to-slot').click();
  await expect(page.locator(BODY)).toHaveValue('Daily {{练习方式}} builds confidence.');
  await expect(page.locator('#slot-fields [data-slot-name="练习方式"]')).toHaveValue('practice');
  await expect(page.locator(INTRO)).toHaveValue('This is my introduction.');
  await expect(page.locator(CONCLUSION)).toHaveValue('This is my conclusion.');
  await page.locator('#slot-fields [data-slot-name="练习方式"]').fill('reflection');
  await expect(page.locator('#template-preview')).toContainText('Daily reflection builds confidence.');
  assertClean(control);
});

test('an old three-paragraph draft restores without migration and is independent of another exam task', async ({ page }) => {
  const source = 'My opening about {{主题}}.\n\nMy own supporting paragraph.\n\nMy own closing paragraph.';
  await seedDraft(page, { source, slots: [{ name: '主题', type: 'word', value: 'education' }] });
  const control = await installWorkspace(page);
  await openWorkspace(page);
  await expect(page.locator(INTRO)).toHaveValue('My opening about {{主题}}.');
  await expect(page.locator(BODY)).toHaveValue('My own supporting paragraph.');
  await expect(page.locator(CONCLUSION)).toHaveValue('My own closing paragraph.');
  await openWorkspace(page, { paper: OTHER_PAPER });
  await expect(page.locator('#writing-task-prompt')).toContainText('balancing study and exercise');
  await expect(page.locator('#writing-task-word-limit')).toContainText(/120[\s\S]*180/);
  await expect(page.locator('#template-source')).toHaveValue(source);
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('education');
  assertClean(control);
});

test('an old four-paragraph draft uses the full editor and never loses its fourth paragraph', async ({ page }) => {
  const source = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph stays.';
  await seedDraft(page, { source });
  const control = await installWorkspace(page);
  const params = new URLSearchParams({ paper: PAPER, question: QUESTION, page: '1' });
  await page.goto(`/writing.html?${params}`);
  await page.locator('#writing-scope-template').click();
  await expect(page.locator('#template-source')).toBeVisible();
  await expect(page.locator('#template-source')).toHaveValue(source);
  await expect(page.locator('#template-preview')).toHaveText(source);
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText('保存');
  expect(await page.evaluate(() => window.WritingTemplates.list()[0].source)).toBe(source);
  await page.reload();
  await page.locator('#writing-scope-template').click();
  await expect(page.locator('#template-source')).toBeVisible();
  await expect(page.locator('#template-source')).toHaveValue(source);
  assertClean(control);
});

test('a one-paragraph legacy draft is not guessed into three paragraphs by sentence boundaries', async ({ page }) => {
  const source = 'Nowadays, education matters. For example, it creates opportunities. In conclusion, keep learning.';
  await seedDraft(page, { source });
  const control = await installWorkspace(page);
  await openWorkspace(page);
  await expect(page.locator(INTRO)).toHaveValue(source);
  await expect(page.locator(BODY)).toHaveValue('');
  await expect(page.locator(CONCLUSION)).toHaveValue('');
  await expect(page.locator('#template-source')).toHaveValue(source);
  assertClean(control);
});

test('the combined 12,000-character limit rejects an over-limit paragraph without changing the accepted text', async ({ page }) => {
  const control = await installWorkspace(page);
  await openWorkspace(page);
  await page.locator(INTRO).fill('a'.repeat(6000));
  await page.locator(BODY).fill('b'.repeat(5996));
  const accepted = `${'a'.repeat(6000)}\n\n${'b'.repeat(5996)}`;
  await expect(page.locator('#template-source')).toHaveValue(accepted);
  await page.locator(CONCLUSION).fill('XYZ');
  await expect(page.locator('#writing-status')).toContainText(/12,000|12000|字符/);
  await expect(page.locator('#template-source')).toHaveValue(accepted);
  await expect(page.locator(INTRO)).toHaveValue('a'.repeat(6000));
  await expect(page.locator(BODY)).toHaveValue('b'.repeat(5996));
  await expect(page.locator(CONCLUSION)).toHaveValue('');
  await page.locator('#template-name').fill('合计上限测试');
  await page.locator('#save-template').click();
  expect(await page.evaluate(() => window.WritingTemplates.list()[0].source)).toBe(accepted);
  assertClean(control);
});

test('a delayed task response cannot overwrite an existing template or newly typed paragraphs', async ({ page }) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const control = await installWorkspace(page, { waitForQuestions: waiting });
  await openWorkspace(page);
  await page.locator('#template-name').fill('请求期间写的模板');
  await page.locator(INTRO).fill('My introduction written while the question loads.');
  await page.locator(BODY).fill('My supporting argument.');
  release();
  await expect(page.locator('#writing-task-prompt')).toContainText('Education creates opportunities for everyone.');
  await expect(page.locator(INTRO)).toHaveValue('My introduction written while the question loads.');
  await expect(page.locator(BODY)).toHaveValue('My supporting argument.');
  await expect(page.locator(CONCLUSION)).toHaveValue('');
  await expect(page.locator('#template-name')).toHaveValue('请求期间写的模板');
  await expect(page.locator('#template-source')).not.toHaveValue(TASK);
  assertClean(control);
});

test('compiled fill-ins contribute to estimated word counts and only the actual task range controls the hint', async ({ page }) => {
  const control = await installWorkspace(page, { questions: [writingQuestion(OTHER_TASK)] });
  await openWorkspace(page);
  await expect(page.locator('#writing-task-word-limit')).toContainText(/120[\s\S]*180/);
  await page.locator(INTRO).fill('word '.repeat(119));
  await expect(page.locator('#writing-word-count')).toHaveText('119');
  await expect(page.locator('#writing-length-state')).toHaveAttribute('data-state', 'short');
  await page.locator(BODY).fill('{{观点}}');
  await expect(page.locator('#writing-word-count')).toHaveText('119');
  await page.locator('#slot-fields [data-slot-name="观点"]').fill('learning');
  await expect(page.locator('#writing-word-count')).toHaveText('120');
  await expect(page.locator('#writing-paragraph-body-count')).toHaveText('1 词');
  await expect(page.locator('#writing-length-state')).toHaveAttribute('data-state', 'within');
  await page.locator(CONCLUSION).fill('more '.repeat(61));
  await expect(page.locator('#writing-word-count')).toHaveText('181');
  await expect(page.locator('#writing-length-state')).toHaveAttribute('data-state', 'long');
  await page.route(`**/api/exams/${PAPER}/questions`, (route) => route.fulfill({ json: {
    questions: [writingQuestion('Directions: Write an essay about your own learning habits. No word range is provided here.')],
  } }));
  await page.reload();
  await page.locator('#writing-scope-template').click();
  await expect(page.locator('#writing-task-prompt')).toContainText('learning habits');
  await expect(page.locator('#writing-task-word-limit')).toBeHidden();
  await expect(page.locator('#writing-length-state')).toHaveAttribute('data-state', 'unknown');
  await expect(page.locator('#writing-word-count')).toHaveText('181');
  assertClean(control);
});

test('question text and paragraph HTML render only as inert text and never fetch remote images', async ({ page }) => {
  const attack = '<img src="https://forbidden.invalid/payload.png" onerror="window.__writingWorkspaceXss=1"><script>window.__writingWorkspaceXss=2</script>';
  const control = await installWorkspace(page, { questions: [writingQuestion(`Directions: Write an essay about this literal text: ${attack}`)] });
  await openWorkspace(page);
  await expect(page.locator('#writing-task-prompt')).toContainText(attack);
  await page.locator(INTRO).fill(`My own literal ${attack}`);
  await expect(page.locator('#template-preview')).toContainText(attack);
  await expect(page.locator('#writing-task-prompt img, #writing-task-prompt script, #template-preview img, #template-preview script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__writingWorkspaceXss)).toBeUndefined();
  expect(await page.evaluate((key) => localStorage.getItem(key), LIBRARY_KEY)).toBeNull();
  assertClean(control);
});
