const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT, PAPER_ID, modelReply } = require('./reader-fixture.cjs');

const NOTES_KEY = 'cet:translation-notes:v1';
const READER_KEY = `exam-viewer:${PAPER_ID}:v1`;
const ORIGINAL = '随着学习不断深入，我们能够表达得更加准确。';
const METHOD_ID = 'cet6-translation-section-01';
const items = [
  { questionId: 'q1', number: 1, type: 'single_choice', page: 1, stem: 'Choose an answer.', confidence: .99,
    bbox: { x: 120, y: 180, width: 380, height: 100 }, options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: label })) },
  { questionId: 'translation-1', number: 61, type: 'translation', page: 1, stem: ORIGINAL, confidence: .99,
    bbox: { x: 110, y: 340, width: 410, height: 150 } },
];

function savedNote(paper = PAPER_ID, extra = {}) {
  return { contextKey: `${paper}:question:translation-1`, paper, question: 'translation-1', page: 1,
    original: ORIGINAL, firstDraft: 'With study deepen, we speak better.', revised: 'As our studies deepen, we express ourselves more accurately.',
    reason: 'as 后使用完整分句。', method: '随着：with 与 as', freeNote: '', updatedAt: '2026-10-08T08:00:00Z', ...extra };
}

async function workspace(page, { question = 'translation-1', answer = '', notes = [], respond } = {}) {
  const control = await setupReader(page, { questions: items, respond });
  await page.route('**/api/learning-methods/translation-notes', (route) => route.fulfill({ json: {
    status: 'ready', cards: [
      { id: METHOD_ID, title: '随着：with 与 as', category: '句型方法', keywords: ['随着'], bodyMarkdown: 'with + 名词；as + 完整分句。' },
      { id: 'cet6-translation-section-02', title: '时态与时间线', category: '翻译步骤', keywords: ['时态'], bodyMarkdown: '先确认时间。' },
    ], source: { attribution: '合成学习资料', caution: '非官方解析' },
  } }));
  await page.addInitScript(({ key, answer, notesKey, notes }) => {
    if (location.pathname !== '/translation.html' || sessionStorage.getItem('translation-loop-initialized')) return;
    sessionStorage.setItem('translation-loop-initialized', '1');
    const prior = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...prior, answers: { q1: 'B', ...(answer ? { 'translation-1': answer } : {}) },
      flagged: ['q1'], writingTemplates: { 'writing-1': { source: 'Keep my template.', slots: [] } }, submitted: true, grade: { total: 1 } }));
    if (notes.length) localStorage.setItem(notesKey, JSON.stringify(notes));
  }, { key: READER_KEY, answer, notesKey: NOTES_KEY, notes });
  await page.goto(`/translation.html?paper=${PAPER_ID}${question ? `&question=${question}` : ''}&page=1`);
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(2);
  if (question === 'translation-1') await expect(page.locator('#apply-translation-answer')).toBeEnabled();
  return control;
}

test('applying a revised translation previews, confirms overwrite and preserves unrelated exam records', async ({ page }) => {
  const control = await workspace(page, { answer: 'My old answer.' });
  await page.locator('#translation-first-draft').fill('My first draft.');
  await page.locator('#translation-revised-text').fill('My carefully revised translation.');
  await page.locator('#apply-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-text')).toHaveText('My carefully revised translation.');
  await expect(page.locator('#translation-existing-answer-text')).toHaveText('My old answer.');
  await expect(page.locator('#confirm-translation-answer')).toBeDisabled();
  await page.locator('#translation-overwrite-confirm').check();
  await page.locator('#confirm-translation-answer').click();
  await expect(page).toHaveURL(/\/reader\.html\?/);
  await expect(page.locator('[data-long-answer="translation-1"]')).toHaveValue('My carefully revised translation.');
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), READER_KEY);
  expect(state.answers.q1).toBe('B'); expect(state.flagged).toContain('q1');
  expect(state.writingTemplates['writing-1'].source).toBe('Keep my template.');
  expect(state.submitted).toBe(false); expect(state.grade).toBeNull();
  expect(control.requests).toEqual([]); expect(control.pageErrors).toEqual([]);
});

test('first draft can be chosen explicitly and cancel leaves the exam answer untouched', async ({ page }) => {
  await workspace(page);
  await page.locator('#translation-first-draft').fill('An original attempt.');
  await page.locator('#translation-revised-text').fill('Another version.');
  await page.locator('#translation-answer-source').selectOption('firstDraft');
  await page.locator('#apply-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-text')).toHaveText('An original attempt.');
  await page.locator('#cancel-translation-answer').click();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['translation-1'], READER_KEY)).toBeUndefined();
  await page.locator('#apply-translation-answer').click();
  await page.locator('#confirm-translation-answer').click();
  await expect(page).toHaveURL(/\/reader\.html\?/);
  await expect(page.locator('[data-long-answer="translation-1"]')).toHaveValue('An original attempt.');
});

test('concurrent answer changes are not overwritten by a stale preview', async ({ page }) => {
  await workspace(page, { answer: 'Original saved answer.' });
  await page.locator('#translation-revised-text').fill('The working translation.');
  await page.locator('#apply-translation-answer').click();
  await page.locator('#translation-overwrite-confirm').check();
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)); state.answers['translation-1'] = 'A newer answer from another tab.';
    localStorage.setItem(key, JSON.stringify(state));
  }, READER_KEY);
  await page.locator('#confirm-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-state')).toContainText('另一个窗口修改');
  await expect(page).toHaveURL(/\/translation\.html\?/);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['translation-1'], READER_KEY)).toBe('A newer answer from another tab.');
});

test('a retyped or removed question prevents a preview from writing an answer', async ({ page }) => {
  await workspace(page);
  await page.locator('#translation-revised-text').fill('Keep this manual text.');
  await page.locator('#apply-translation-answer').click();
  await page.route(`**${API_ROOT}/questions`, (route) => route.fulfill({ json: { revision: 2, questions: items.filter((item) => item.questionId !== 'translation-1') } }));
  await page.locator('#confirm-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-state')).toContainText('题号已变更');
  await expect(page.locator('#translation-revised-text')).toHaveValue('Keep this manual text.');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['translation-1'], READER_KEY)).toBeUndefined();
});

test('editing during a delayed question recheck requires a fresh answer preview', async ({ page }) => {
  await workspace(page);
  await page.locator('#translation-revised-text').fill('The version in the preview.');
  await page.locator('#apply-translation-answer').click();
  let release;
  const checked = new Promise((resolve) => { release = resolve; });
  await page.route(`**${API_ROOT}/questions`, async (route) => { await checked; return route.fulfill({ json: { revision: 1, questions: items } }); });
  await page.locator('#confirm-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-state')).toContainText('正在确认');
  await page.locator('#translation-revised-text').evaluate((input) => { input.value = 'A newer version after the preview.'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  release();
  await expect(page.locator('#translation-answer-preview-state')).toContainText('译文已发生变化');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).answers['translation-1'], READER_KEY)).toBeUndefined();
});

test('saving a notebook does not overwrite a newer formally saved copy from another window', async ({ page }) => {
  await workspace(page, { notes: [savedNote()] });
  await page.locator('#translation-free-note').fill('The current working reflection.');
  await page.evaluate((key) => {
    const notes = JSON.parse(localStorage.getItem(key)); notes[0].freeNote = 'A newer reflection saved elsewhere.'; notes[0].updatedAt = '2026-10-09T00:00:00Z';
    localStorage.setItem(key, JSON.stringify(notes));
  }, NOTES_KEY);
  await page.locator('#save-translation-note').click();
  await expect(page.locator('#translation-status')).toContainText('另一个窗口修改');
  await expect(page.locator('#translation-free-note')).toHaveValue('The current working reflection.');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key))[0].freeNote, NOTES_KEY)).toBe('A newer reflection saved elsewhere.');
});

test('corrupted exam data and quota errors keep all editing text and do not navigate', async ({ page }) => {
  await workspace(page);
  await page.locator('#translation-revised-text').fill('Important translation.');
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), READER_KEY);
  await page.locator('#apply-translation-answer').click();
  await expect(page.locator('#translation-status')).toContainText('无法读取');
  expect(await page.evaluate((key) => localStorage.getItem(key), READER_KEY)).toBe('{broken');
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ answers: {} })), READER_KEY);
  await page.locator('#apply-translation-answer').click();
  await page.evaluate((key) => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('full', 'QuotaExceededError'); return write.call(this, name, value); };
  }, READER_KEY);
  await page.locator('#confirm-translation-answer').click();
  await expect(page.locator('#translation-answer-preview-state')).toContainText('保存失败');
  await expect(page).toHaveURL(/\/translation\.html\?/);
  await expect(page.locator('#translation-revised-text')).toHaveValue('Important translation.');
});

test('page-only and wrong-type contexts cannot create guessed question answer IDs', async ({ page }) => {
  await workspace(page, { question: '' });
  await expect(page.locator('#apply-translation-answer')).toBeDisabled();
  await page.locator('#translation-first-draft').fill('A page-scoped notebook.');
  await page.locator('#save-translation-note').click();
  expect(await page.evaluate((key) => Object.keys(JSON.parse(localStorage.getItem(key)).answers), READER_KEY)).toEqual(['q1']);
  await page.goto(`/translation.html?paper=${PAPER_ID}&question=q1&page=1`);
  await expect(page.locator('#apply-translation-answer')).toBeDisabled();
});

test('method associations persist independently from free-form remarks and show previous mistakes with original links', async ({ page }) => {
  const older = savedNote('older-paper', { methodRefs: [{ source: 'github', id: METHOD_ID, title: '随着：with 与 as' }] });
  const legacy = savedNote(PAPER_ID, { revised: '', methodRefs: undefined });
  await workspace(page, { notes: [older, legacy] });
  await expect(page.locator('#translation-method-history')).toContainText('older-paper');
  await page.locator('#translation-method-history details').first().click();
  await expect(page.locator('#translation-method-history')).toContainText('as 后使用完整分句');
  await expect(page.locator('#translation-method-history a')).toHaveAttribute('href', /paper=older-paper.*question=translation-1/);
  await page.locator('#use-translation-method').click();
  await expect(page.locator('#translation-used-method')).toHaveValue('随着：with 与 as');
  await expect(page.locator('#translation-bound-methods')).toContainText('随着');
  await page.locator('#save-translation-note').click();
  const note = await page.evaluate(({ key, paper }) => JSON.parse(localStorage.getItem(key)).find((note) => note.paper === paper), { key: NOTES_KEY, paper: PAPER_ID });
  expect(note.methodRefs).toEqual([{ source: 'github', id: METHOD_ID, title: '随着：with 与 as' }]);
  await page.reload(); await expect(page.locator('#translation-bound-methods')).toContainText('随着');
  await page.locator('#translation-bound-methods button').click();
  await page.locator('#save-translation-note').click();
  expect(await page.evaluate(({ key, paper }) => JSON.parse(localStorage.getItem(key)).find((note) => note.paper === paper).methodRefs, { key: NOTES_KEY, paper: PAPER_ID })).toEqual([]);
});

test('personal method IDs remain stable when a previous chapter is inserted', async ({ page }) => {
  await workspace(page);
  await page.locator('#translation-source-personal').click();
  await page.locator('#translation-method-source').fill('## 2 方法甲\n我自己的例句。');
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(1);
  const first = await page.locator('#translation-method-catalog [data-method-id]').getAttribute('data-method-id');
  await page.locator('#translation-method-source').fill('## 1 前置方法\n前面的内容。\n\n## 2 方法甲\n我自己的例句。');
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(2);
  expect(await page.locator('#translation-method-catalog [data-method-id]').nth(1).getAttribute('data-method-id')).toBe(first);
});

test('learning AI is explicit, keeps personal data private by default and supports scoped consent with sources', async ({ page }) => {
  const privateNote = savedNote('private-paper', { reason: 'PRIVATE_REASON', methodRefs: [{ source: 'github', id: METHOD_ID, title: '随着' }] });
  const control = await workspace(page, { notes: [privateNote], respond: (route, body) => route.fulfill({ json: {
    ...modelReply(body, `## 下一步\n\n${body.learningContext.consentPersonal ? 'PRIVATE_REPLY_FROM_PERSONAL_NOTES' : '先判断句子的主干。'}`),
    learningCitations: [{ id: METHOD_ID, title: '随着：with 与 as', kind: 'learning_method' }],
  } }) });
  await page.locator('#translation-method-source').fill('PRIVATE_METHOD');
  await page.locator('#translation-revised-text').fill('My current translation.');
  expect(control.requests).toEqual([]);
  await page.locator('[data-translation-ai="hint"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  const first = control.requests[0].body;
  expect(first.scope).toBe('question'); expect(first.questionId).toBe('translation-1');
  expect(first.learningContext).toEqual({ mode: 'hint', methodIds: [METHOD_ID], consentPersonal: false });
  expect(JSON.stringify(first)).not.toContain('PRIVATE_');
  expect(first.userAnswer).toBe('My current translation.');
  await expect(page.locator('#translation-ai-reply h2')).toHaveText('下一步');
  await expect(page.locator('#translation-ai-citations')).toContainText('非官方解析');
  await page.locator('#translation-ai-consent').check();
  await page.locator('[data-translation-ai="method"]').click();
  await expect.poll(() => control.requests.length).toBe(2);
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  expect(control.requests[1].body.learningContext.personalMethods).toBe('PRIVATE_METHOD');
  expect(control.requests[1].body.learningContext.notes[0].reason).toBe('PRIVATE_REASON');
  await expect(page.locator('#translation-ai-reply')).toContainText('PRIVATE_REPLY_FROM_PERSONAL_NOTES');
  await page.locator('#translation-ai-consent').uncheck();
  await page.locator('[data-translation-ai="review"]').click();
  await expect.poll(() => control.requests.length).toBe(3);
  expect(control.requests[2].body.history).toEqual([]);
  expect(JSON.stringify(control.requests[2].body)).not.toContain('PRIVATE_');
  expect(control.outsideRequests).toEqual([]); expect(control.pageErrors).toEqual([]);
});

test('page-only AI uses selection scope and failed or unconfigured models retain the input', async ({ page }) => {
  const control = await workspace(page, { question: '', respond: (route, body) => route.fulfill({ json: {
    ...modelReply(body), generation: { used: false, fallbackReason: 'not_configured' },
  } }) });
  await page.locator('#translation-source-text').fill('这是本次明确提供的原句。');
  await page.locator('#translation-ai-input').fill('不要代写，先给提示。');
  await page.locator('#translation-ai-input').press('Enter');
  await expect(page.locator('#translation-ai-state')).toContainText('尚未配置');
  await expect(page.locator('#translation-ai-input')).toHaveValue('不要代写，先给提示。');
  expect(control.requests[0].body.scope).toBe('selection');
  expect(control.requests[0].body.selectedText).toContain('本次明确提供');
  expect(control.requests[0].body.questionId).toBeUndefined();
});

test('a selected personal chapter is used rather than an earlier long chapter and needs consent for method analysis', async ({ page }) => {
  const control = await workspace(page);
  await page.locator('#translation-source-personal').click();
  const selectedBody = 'PERSONAL_SELECTED_BODY：先找主语和谓语，再安排修饰语。';
  await page.locator('#translation-method-source').fill(`## 1 前置方法\nPRIVATE_PREFIX_${'x'.repeat(3200)}\n\n## 2 主干方法\n${selectedBody}`);
  await expect(page.locator('#translation-method-catalog [data-method-id]')).toHaveCount(2);
  await page.locator('#translation-method-catalog [data-method-id]').nth(1).click();
  await expect(page.locator('#translation-method-detail-title')).toHaveText('2 主干方法');
  await page.locator('[data-translation-ai="method"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('本次没有发送请求');
  expect(control.requests).toEqual([]);
  // Hint/review remain available without sending the selected private method.
  await page.locator('[data-translation-ai="hint"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  expect(control.requests[0].body.learningContext.consentPersonal).toBe(false);
  expect(JSON.stringify(control.requests[0].body)).not.toContain('PERSONAL_SELECTED_BODY');
  await page.locator('#translation-ai-consent').check();
  await page.locator('[data-translation-ai="method"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('选定的个人方法');
  const body = control.requests[1].body;
  expect(body.learningContext.personalMethods).toContain('2 主干方法');
  expect(body.learningContext.personalMethods).toContain(selectedBody);
  expect(JSON.stringify(body)).not.toContain('PRIVATE_PREFIX_');
  expect(control.outsideRequests).toEqual([]);
});

test('a long translation is passed as the complete current answer instead of an oversized prompt', async ({ page }) => {
  const control = await workspace(page);
  const longAnswer = 'We learn by practice and reflection. '.repeat(120);
  await page.locator('#translation-revised-text').fill(longAnswer);
  await page.locator('#translation-ai-input').fill('只检查措辞和时态。');
  await page.locator('[data-translation-ai="review"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  const body = control.requests[0].body;
  expect(body.userAnswer).toBe(longAnswer.trim());
  expect(body.message.length).toBeLessThanOrEqual(2000);
  expect(body.message).not.toContain(longAnswer.trim());
});

test('AI HTML and unsafe links remain inert and an IME Enter does not send', async ({ page }) => {
  const control = await workspace(page, { respond: (route, body) => route.fulfill({ json: modelReply(body,
    '<img src="https://forbidden.example/x" onerror="window.__bad=1">\n[bad](javascript:alert(1))\n\n**辅助建议**') }) });
  await page.locator('#translation-ai-input').fill('检查一下。');
  await page.locator('#translation-ai-input').evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  expect(control.requests).toEqual([]);
  await page.locator('[data-translation-ai="review"]').click();
  await expect(page.locator('#translation-ai-reply')).toContainText('辅助建议');
  await expect(page.locator('#translation-ai-reply img, #translation-ai-reply a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__bad)).toBeUndefined();
  expect(control.outsideRequests).toEqual([]);
});

test('mobile tabs keep work and resources accessible, focus mode and fixed actions do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  await expect(page.locator('#translation-source-text')).toBeVisible();
  await expect(page.locator('.catalog-panel')).toBeHidden();
  await page.locator('[data-translation-view="methods"]').click();
  await expect(page.locator('.catalog-panel')).toBeVisible();
  await expect(page.locator('#translation-method-detail')).toBeVisible();
  await page.locator('[data-translation-view="resources"]').click();
  await expect(page.locator('#translation-method-source')).toBeVisible();
  await expect(page.locator('#translation-expression-library')).toBeVisible();
  await page.locator('[data-translation-view="practice"]').click();
  await page.locator('#translation-focus-toggle').click();
  await expect(page.locator('#translation-focus-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.translation-mobile-actions')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.locator('#translation-free-note').fill('A mobile thought.');
  await page.locator('#translation-mobile-save').click();
  await expect(page.locator('#translation-note-state')).toHaveText('这份笔记已保存');
});
