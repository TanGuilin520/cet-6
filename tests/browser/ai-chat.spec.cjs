const { test, expect } = require('@playwright/test');
const {
  INPUT, MESSAGES, ASSISTANT_BODIES, USER_MESSAGES,
  setupReader, openChat, sendMessage, selectPdfWords, modelReply,
} = require('./reader-fixture.cjs');

test('free chat needs no questions and survives a page reload', async ({ page }) => {
  const control = await setupReader(page, { questions: [] });
  await openChat(page);
  await sendMessage(page, '怎样练习英语？');
  await expect(page.locator(ASSISTANT_BODIES)).toContainText('怎样练习英语？');
  expect(control.requests[0].body.scope).toBe('general');
  expect(control.requests[0].body.questionId).toBeFalsy();
  await page.reload();
  await expect(page.locator('.pdf-word')).toHaveCount(4);
  await openChat(page);
  await expect(page.locator(USER_MESSAGES)).toHaveText(['怎样练习英语？']);
  await sendMessage(page, '再举一个例子');
  expect(control.requests[1].body.history.some((item) => item.content === '怎样练习英语？')).toBeTruthy();
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
});

test('Enter sends, Shift+Enter creates a newline, and IME Enter never submits', async ({ page }) => {
  const control = await setupReader(page);
  await openChat(page);
  const input = page.locator(INPUT);
  await input.press('Enter');
  expect(control.requests).toHaveLength(0);
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('第一行\n');
  await input.pressSequentially('second');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  expect(control.requests).toHaveLength(0);
  await input.press('Enter');
  await expect(page.locator(ASSISTANT_BODIES)).toHaveCount(1);
  expect(control.requests).toHaveLength(1);
  expect(control.requests[0].body.message).toContain('第一行\nsecond');
  await expect(input).toHaveValue('');
});

test('long Chinese multi-turn history fits both character and UTF-8 payload limits', async ({ page }) => {
  const control = await setupReader(page, { respond: (route, body) => route.fulfill({
    json: modelReply(body, `## 第 ${body.message} 轮\n\n${'解释'.repeat(3500)}`),
  }) });
  await openChat(page);
  for (let turn = 1; turn <= 9; turn += 1) {
    await sendMessage(page, `追问${turn}`);
    await expect(page.locator(ASSISTANT_BODIES).last()).toContainText(`追问${turn}`);
  }
  expect(control.requests).toHaveLength(9);
  for (const { body, bytes } of control.requests) {
    expect(bytes).toBeLessThanOrEqual(48 * 1024);
    expect(body.history.length).toBeLessThanOrEqual(12);
    for (const message of body.history) expect(message.content.length).toBeLessThanOrEqual(4000);
  }
  const lastHistory = control.requests.at(-1).body.history;
  expect(lastHistory.some((message) => message.content.includes('追问8'))).toBeTruthy();
  expect(lastHistory.length).toBeLessThan(12); // UTF-8 bytes, not only JS string length.
});

test('HTTP failure keeps the draft and retry inserts the question only once', async ({ page }) => {
  const control = await setupReader(page, { respond: (route, body, count) => count === 1
    ? route.fulfill({ status: 429, json: { error: '请求过于频繁，请稍后重试。' } })
    : route.fulfill({ json: modelReply(body, '重试成功。') }),
  });
  await openChat(page);
  await sendMessage(page, '请解释现在完成时');
  await expect(page.locator('#ai-chat-status')).toContainText('频繁');
  await expect(page.locator(INPUT)).toHaveValue('请解释现在完成时');
  await expect(page.locator('#ai-retry-last')).toBeVisible();
  await page.locator('#ai-retry-last').click();
  await expect(page.locator(ASSISTANT_BODIES)).toHaveText(['重试成功。']);
  await expect(page.locator(USER_MESSAGES)).toHaveText(['请解释现在完成时']);
  expect(control.requests).toHaveLength(2);
  expect(control.requests[1].body.history.some((item) => item.content.includes('请求过于频繁'))).toBeFalsy();
  await expect(page.locator(INPUT)).toHaveValue('');
});

test('a model fallback is a visible retryable failure in free chat', async ({ page }) => {
  await setupReader(page, { respond: (route, body) => {
    const response = modelReply(body, 'No model was called');
    response.generation = {
      provider: 'deterministic', model: null, attempted: false, used: false,
      fallbackReason: 'not_configured', usage: null,
    };
    return route.fulfill({ json: response });
  } });
  await openChat(page);
  await sendMessage(page, '为什么没有回复？');
  await expect(page.locator('#ai-chat-status')).toContainText(/配置|API Key/);
  await expect(page.locator('#ai-retry-last')).toBeVisible();
  await expect(page.locator(INPUT)).toHaveValue('为什么没有回复？');
  await expect(page.locator(ASSISTANT_BODIES)).toHaveCount(0);
});

test('request locks mode/new-chat controls and duplicate Enter cannot send twice', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const control = await setupReader(page, { respond: async (route, body) => {
    await gate;
    await route.fulfill({ json: modelReply(body, '延迟回答完成') });
  } });
  await openChat(page);
  await page.locator(INPUT).fill('慢速问题');
  await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-send-button')).toBeDisabled();
  await expect(page.locator('#ai-new-chat')).toBeDisabled();
  await expect(page.locator('[data-ai-scope="question"]')).toBeDisabled();
  await page.locator(INPUT).dispatchEvent('keydown', { key: 'Enter' });
  expect(control.requests).toHaveLength(1);
  release();
  await expect(page.locator(ASSISTANT_BODIES)).toHaveText(['延迟回答完成']);
  await expect(page.locator('#ai-new-chat')).toBeEnabled();
});

test('free and question threads stay isolated and new-chat clears only one thread', async ({ page }) => {
  const control = await setupReader(page);
  await openChat(page);
  await sendMessage(page, '自由线程问题');
  await page.locator('[data-ai-scope="question"]').click();
  await expect(page.locator(USER_MESSAGES)).toHaveCount(0);
  await sendMessage(page, '题目线程问题');
  expect(control.requests[1].body.questionId).toBe('q1');
  expect(control.requests[1].body.history).toEqual([]);
  await page.locator('[data-ai-scope="general"]').click();
  await expect(page.locator(USER_MESSAGES)).toHaveText(['自由线程问题']);
  await page.locator('#ai-new-chat').click();
  await expect(page.locator(USER_MESSAGES)).toHaveCount(0);
  await page.locator('[data-ai-scope="question"]').click();
  await expect(page.locator(USER_MESSAGES)).toHaveText(['题目线程问题']);
});

test('PDF selection survives pointerup and is passed with its selection-only history', async ({ page }) => {
  const control = await setupReader(page);
  await page.locator('[data-tool="highlight"]').click();
  const selectedText = await selectPdfWords(page);
  // Highlighting deliberately clears the native selection on pointerup.
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe('');
  await openChat(page, 'selection');
  await expect(page.locator('#ai-selection-excerpt')).toHaveText(selectedText);
  await sendMessage(page, '翻译这句话');
  expect(control.requests[0].body.scope).toBe('selection');
  expect(control.requests[0].body.selectedText).toBe(selectedText);
  expect(control.requests[0].body.questionId).toBeFalsy();
  await page.locator('[data-ai-scope="general"]').click();
  await expect(page.locator(USER_MESSAGES)).toHaveCount(0);
});

test('selecting toolbar or AI text cannot become PDF context', async ({ page }) => {
  await setupReader(page);
  await openChat(page);
  await page.locator('#paper-title').evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.locator('[data-ai-scope="selection"]')).toBeDisabled();
});

test('Markdown renders safely and an accidental reply envelope is not displayed as JSON', async ({ page }) => {
  await setupReader(page, { respond: (route, body) => route.fulfill({ json: modelReply(body, JSON.stringify({
    reply: '## 写作建议\n\n- 明确立场\n- 给出例子\n\n> Practice helps.\n\n<script>window.__xss = 1</script>\n<img src=x onerror="window.__xss = 2">\n[危险链接](javascript:window.__xss=3)',
  })) }) });
  await openChat(page);
  await sendMessage(page, '写作建议');
  const body = page.locator(ASSISTANT_BODIES);
  await expect(body.getByRole('heading', { name: '写作建议' })).toBeVisible();
  await expect(body.locator('li')).toHaveText(['明确立场', '给出例子']);
  await expect(body.locator('blockquote')).toContainText('Practice helps.');
  await expect(body.locator('script, img, iframe, [onclick], [onerror], a[href^="javascript:"]')).toHaveCount(0);
  await expect(body).not.toContainText('"reply"');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('unknown JSON is rejected with a friendly error instead of leaking internal fields', async ({ page }) => {
  await setupReader(page, { respond: (route, body) => route.fulfill({
    json: modelReply(body, '{"questionId":"secret-internal-id","answerAnalysis":{"hidden":"value"}}'),
  }) });
  await openChat(page);
  await sendMessage(page, '请解释');
  await expect(page.locator('#ai-retry-last')).toBeVisible();
  await expect(page.locator(MESSAGES)).not.toContainText('secret-internal-id');
  await expect(page.locator('#ai-chat-status')).not.toBeEmpty();
});

test('long question answers and source badges persist without truncation after reload', async ({ page }) => {
  const text = `## 详细解析\n${'长解释'.repeat(1400)}\n结尾证据`;
  await setupReader(page, { respond: (route, body) => {
    const response = modelReply(body, text);
    response.grounding = { officialExplanationFound: true, disclaimerRequired: false };
    return route.fulfill({ json: response });
  } });
  await openChat(page, 'question');
  await sendMessage(page, '解释第一题');
  await expect(page.locator(ASSISTANT_BODIES)).toContainText('结尾证据');
  await page.reload();
  await expect(page.locator('#question-navigator button')).toHaveCount(2);
  await openChat(page, 'question');
  await expect(page.locator(ASSISTANT_BODIES)).toContainText('结尾证据');
  await expect(page.locator('.ai-source-chip--official')).toHaveText('含官方解析');
});

test('unresponsive requests time out and preserve the prompt for retry', async ({ page }) => {
  await page.clock.install();
  const control = await setupReader(page, { respond: () => new Promise(() => {}) });
  await openChat(page);
  await page.locator(INPUT).fill('超时问题');
  await page.locator(INPUT).press('Enter');
  await expect.poll(() => control.requests.length).toBe(1);
  await page.clock.fastForward(90_001);
  await expect(page.locator('#ai-chat-status')).toContainText('超时');
  await expect(page.locator(INPUT)).toHaveValue('超时问题');
  await expect(page.locator('#ai-send-button')).toBeEnabled();
  await expect(page.locator('#ai-retry-last')).toBeVisible();
});
