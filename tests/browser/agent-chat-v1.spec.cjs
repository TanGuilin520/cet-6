const { test, expect } = require('@playwright/test');
const { setupReader, openChat, sendMessage, modelReply, API_ROOT, PAPER_ID, INPUT, ASSISTANT_BODIES, USER_MESSAGES } = require('./reader-fixture.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READY = { configured: true, reachable: true, ready: true, engine: 'langgraph', streaming: true, memory: true };
const READER_KEY = `exam-viewer:${PAPER_ID}:v1`;

async function capabilities(page, agent = READY) {
  await page.route('**/api/exams/capabilities', (route) => route.fulfill({ json: { agent } }));
  await page.reload();
  await expect(page.locator('.pdf-word')).toHaveCount(4);
}

async function mockStream(page, { final = true, hold = false, error = null, reply = '## 完整回答\n\n依据已核对。', deltas = ['先核对原句。'], gap = 100 } = {}) {
  await page.addInitScript(({ final, hold, error, reply, deltas, gap, root }) => {
    const nativeFetch = window.fetch.bind(window);
    window.__streamRequests = [];
    window.fetch = async (url, options = {}) => {
      if (new URL(url, location.href).pathname !== `${root}/assistant/stream`) return nativeFetch(url, options);
      const body = JSON.parse(options.body); window.__streamRequests.push(body);
      const result = { scope: body.scope, questionId: body.questionId || null, revision: 1, requestId: body.requestId, reply,
        grounding: { officialExplanationFound: false, disclaimerRequired: body.scope === 'question' }, citations: [],
        learningCitations: [{ title: '随着：with 与 as', kind: 'learning_method', official: false }],
        generation: { provider: 'deepseek', model: 'offline-browser-fixture', attempted: true, used: true, usage: { totalTokens: 42 } },
        agent: { runId: 'synthetic-run', intent: 'learning_hint', tools: [{ name: 'retrieve_methods', status: 'ok' }],
          trace: { nodes: ['agent_tools', 'generate'], durationMs: 321 }, execution: { mode: 'dynamic_tools', rounds: 2, toolCalls: 1, stopReason: 'final_answer' },
          memory: { enabled: true, turns: 1, summaryPresent: false } } };
      const frames = [ { event: 'progress', data: { node: 'retrieve_methods', tool: 'retrieve_methods', status: 'ok' } },
        ...deltas.map((text) => ({ event: 'reply_delta', data: { text } })),
        ...(error ? [{ event: 'error', data: error }] : final ? [{ event: 'result', data: result }] : []) ];
      const timers = []; let closed = false;
      const stream = new ReadableStream({ start(controller) {
        options.signal?.addEventListener('abort', () => { if (!closed) { closed = true; timers.forEach(clearTimeout); controller.error(new DOMException('Stopped', 'AbortError')); } }, { once: true });
        frames.forEach((frame, index) => timers.push(setTimeout(() => {
          if (closed) return;
          controller.enqueue(new TextEncoder().encode(`event: ${frame.event}\r\ndata: ${JSON.stringify(frame.data)}\r\n\r\n`));
          if (index === frames.length - 1 && !hold) { closed = true; controller.close(); }
        }, gap * index)));
      }, cancel() { closed = true; timers.forEach(clearTimeout); } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    };
  }, { final, hold, error, reply, deltas, gap, root: API_ROOT });
}

test('runtime status distinguishes disabled, unavailable and ready Agent from direct chat', async ({ page }) => {
  const control = await setupReader(page);
  await capabilities(page, { configured: false, reachable: false, ready: false, streaming: false, memory: false });
  await openChat(page, 'question');
  await expect(page.locator('#ai-runtime-status')).toContainText('LangGraph 未启用');
  await sendMessage(page, '只提示下一步');
  expect(control.requests).toHaveLength(1);
  await page.locator('[data-ai-scope="general"]').click();
  await expect(page.locator('#ai-runtime-status')).toContainText('直连 DeepSeek');
  await capabilities(page, { configured: true, reachable: false, ready: false });
  await openChat(page, 'question');
  await expect(page.locator('#ai-runtime-status')).toContainText('不可连接');
  await capabilities(page);
  await openChat(page, 'question');
  await expect(page.locator('#ai-runtime-status')).toContainText('LangGraph 已就绪');
  expect(control.pageErrors).toEqual([]);
});

test('SSE uses real progress, safe text deltas, final Markdown and execution provenance', async ({ page }) => {
  await mockStream(page, { deltas: ['第一句。', '<img src=x onerror="window.__xss=1">'], gap: 250 });
  const control = await setupReader(page);
  await capabilities(page);
  await openChat(page, 'question');
  await page.locator(INPUT).fill('解释方法'); await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-chat-status')).toContainText('retrieve_methods');
  await expect(page.locator('.ai-stream-text')).toContainText('第一句');
  await expect(page.locator('#ai-question-messages img')).toHaveCount(0);
  await expect(page.locator(ASSISTANT_BODIES)).toContainText('依据已核对');
  await expect(page.locator('#ai-question-messages')).toContainText('实际工具调用次数：1');
  await expect(page.locator('#ai-question-messages')).toContainText('321 ms');
  await expect(page.locator('#ai-question-messages')).toContainText('随着：with 与 as');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.evaluate(() => window.__streamRequests.length)).toBe(1);
  expect(control.requests).toHaveLength(0); expect(control.outsideRequests).toEqual([]); expect(control.pageErrors).toEqual([]);
});

test('cancel preserves partial text and prompt without committing history or auto-retrying', async ({ page }) => {
  await mockStream(page, { final: false, hold: true, deltas: ['尚未完整的安全片段'], gap: 100 });
  const control = await setupReader(page); await capabilities(page); await openChat(page);
  await page.locator(INPUT).fill('停止测试'); await page.locator(INPUT).press('Enter');
  await expect(page.locator('.ai-stream-text')).toContainText('安全片段');
  await page.locator('#ai-stop-reply').click();
  await expect(page.locator('#ai-chat-status')).toContainText('已停止');
  await expect(page.locator(INPUT)).toHaveValue('停止测试');
  await expect(page.locator('.ai-stream-text')).toContainText('安全片段');
  await expect(page.locator(USER_MESSAGES)).toHaveCount(0); await expect(page.locator(ASSISTANT_BODIES)).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).aiFreeHistory.length, READER_KEY)).toBe(0);
  expect(await page.evaluate(() => window.__streamRequests.length)).toBe(1); expect(control.requests).toEqual([]);
});

test('EOF without result is a failure and never creates a second paid fallback call', async ({ page }) => {
  await mockStream(page, { final: false, deltas: ['截断片段'] });
  const control = await setupReader(page); await capabilities(page); await openChat(page);
  await page.locator(INPUT).fill('截断测试'); await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-chat-status')).toContainText('中断');
  await expect(page.locator('#ai-send-button')).toBeEnabled(); await expect(page.locator(INPUT)).toHaveValue('截断测试');
  await expect(page.locator(ASSISTANT_BODIES)).toHaveCount(0); await expect(page.locator('.ai-stream-text')).toContainText('截断片段');
  expect(await page.evaluate(() => window.__streamRequests.length)).toBe(1); expect(control.requests).toEqual([]);
});

test('terminal stream error remains friendly and preserves draft without JSON leaks', async ({ page }) => {
  await mockStream(page, { final: false, error: { code: 'upstream_rate_limited', message: '模型请求过于频繁。' }, deltas: [] });
  const control = await setupReader(page); await capabilities(page); await openChat(page);
  await page.locator(INPUT).fill('错误测试'); await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-chat-status')).toContainText('频繁'); await expect(page.locator(INPUT)).toHaveValue('错误测试');
  await expect(page.locator('#ai-question-messages')).not.toContainText('upstream_rate_limited');
  expect(control.requests).toEqual([]);
});

test('SSE numeric 409 reloads the review snapshot and does not mix an obsolete answer into history', async ({ page }) => {
  await mockStream(page, { final: false, error: { code: 409, message: '试卷解析版本已更新。' }, deltas: [] });
  const control = await setupReader(page); await capabilities(page); await openChat(page, 'question');
  let reloads = 0;
  await page.route(`**${API_ROOT}/questions`, (route) => { reloads += 1; return route.fulfill({ json: { revision: 2, questions: [{ questionId: 'q1', number: 1, type: 'single_choice', page: 1, stem: 'Updated question', confidence: .99, bbox: { x: 100, y: 180, width: 300, height: 100 }, options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: label })) }] } }); });
  await page.locator(INPUT).fill('旧快照问题'); await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-chat-status')).toContainText('解析已更新');
  await expect.poll(() => reloads).toBe(1);
  await expect(page.locator(ASSISTANT_BODIES)).toHaveCount(0); await expect(page.locator('#ai-retry-last')).toBeHidden();
  await expect(page.locator(INPUT)).toHaveValue('旧快照问题'); expect(control.requests).toEqual([]);
});

test('SSE parser handles split UTF-8 and CRLF chunks and requires a final result', async ({ page }) => {
  await setupReader(page); await capabilities(page);
  const result = await page.evaluate(async () => {
    const nativeFetch = window.fetch; const frame = `event: reply_delta\r\ndata: ${JSON.stringify({ text: '准确' })}\r\n\r\nevent: result\r\ndata: ${JSON.stringify({ reply: '完整译文。' })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(frame); const pieces = []; let calls = 0;
    window.fetch = async () => { calls += 1; return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); };
    try { const data = await window.AgentChat.request({ url: '/synthetic/assistant', body: { scope: 'general' }, onDelta: (text) => pieces.push(text) }); return { data, pieces, calls }; }
    finally { window.fetch = nativeFetch; }
  });
  expect(result.data.reply).toBe('完整译文。'); expect(result.pieces).toEqual(['准确']); expect(result.calls).toBe(1);
});

test('SSE malformed data and HTTP 503 never retry through the legacy route', async ({ page }) => {
  await setupReader(page); await capabilities(page);
  const result = await page.evaluate(async () => {
    const nativeFetch = window.fetch; const errors = []; let calls = 0;
    const candidates = [new Response('event: result\ndata: {BROKEN}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), new Response(JSON.stringify({ error: '暂不可用。' }), { status: 503, headers: { 'Content-Type': 'application/json' } })];
    window.fetch = async () => { calls += 1; return candidates.shift(); };
    try { for (let index = 0; index < 2; index += 1) try { await window.AgentChat.request({ url: '/synthetic/assistant', body: { scope: 'question' } }); } catch (error) { errors.push({ reason: error.fallbackReason, status: error.httpStatus }); } return { calls, errors }; }
    finally { window.fetch = nativeFetch; }
  });
  expect(result.calls).toBe(2); expect(result.errors).toEqual([{ reason: 'invalid_response' }, { status: 503 }]);
});

test('only unsupported stream route falls back to exactly one legacy model request', async ({ page }) => {
  const control = await setupReader(page); await capabilities(page);
  let streams = 0;
  await page.route(`**${API_ROOT}/assistant/stream`, (route) => { streams += 1; return route.fulfill({ status: 404, json: { error: 'No route' } }); });
  await openChat(page); await sendMessage(page, '兼容旧版本');
  await expect(page.locator(ASSISTANT_BODIES)).toContainText('兼容旧版本');
  expect(streams).toBe(1); expect(control.requests).toHaveLength(1);
});

test('conversation UUIDs are stable per thread/reload and memory clears before new question chat', async ({ page }) => {
  const control = await setupReader(page); await capabilities(page, { ...READY, streaming: false });
  const clears = []; await page.route(`**${API_ROOT}/assistant/conversations/clear`, (route) => { clears.push(route.request().postDataJSON()); return route.fulfill({ json: { cleared: true } }); });
  await openChat(page); await sendMessage(page, '自由会话');
  const generalId = control.requests.at(-1).body.conversationId; expect(generalId).toMatch(UUID);
  await page.locator('[data-ai-scope="question"]').click(); await sendMessage(page, '题目会话');
  const questionId = control.requests.at(-1).body.conversationId; expect(questionId).toMatch(UUID); expect(questionId).not.toBe(generalId);
  await page.reload(); await expect(page.locator('.pdf-word')).toHaveCount(4); await openChat(page, 'question');
  await sendMessage(page, '继续题目'); expect(control.requests.at(-1).body.conversationId).toBe(questionId);
  await page.locator('#ai-new-chat').click(); await expect(page.locator(USER_MESSAGES)).toHaveCount(0);
  expect(clears).toEqual([{ conversationId: questionId, scope: 'question', questionId: 'q1' }]);
  await sendMessage(page, '新题目会话'); expect(control.requests.at(-1).body.conversationId).not.toBe(questionId);
  await page.locator('[data-ai-scope="general"]').click(); await expect(page.locator(USER_MESSAGES)).toHaveText(['自由会话']);
  await sendMessage(page, '继续自由'); expect(control.requests.at(-1).body.conversationId).toBe(generalId);
  expect(control.pageErrors).toEqual([]);
});

test('failed memory clear does not falsely clear history or change active UUID', async ({ page }) => {
  const control = await setupReader(page); await capabilities(page, { ...READY, streaming: false });
  await page.route(`**${API_ROOT}/assistant/conversations/clear`, (route) => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await openChat(page, 'question'); await sendMessage(page, '请保留'); const id = control.requests[0].body.conversationId;
  await page.locator('#ai-new-chat').click(); await expect(page.locator('#viewer-toast')).toContainText('未能清除');
  await expect(page.locator(USER_MESSAGES)).toHaveText(['请保留']);
  await sendMessage(page, '仍是原会话'); expect(control.requests.at(-1).body.conversationId).toBe(id);
});

async function translationPage(page, controlOptions = {}) {
  const questions = [{ questionId: 'translation-1', number: 61, type: 'translation', page: 1, stem: '随着学习不断深入，我们表达得更准确。', confidence: .99, bbox: { x: 100, y: 300, width: 400, height: 120 } }];
  const control = await setupReader(page, { questions, ...controlOptions });
  await page.route('**/api/exams/capabilities', (route) => route.fulfill({ json: { agent: READY } }));
  await page.route('**/api/learning-methods/translation-notes', (route) => route.fulfill({ json: { status: 'ready', cards: [], source: { caution: '非官方' } } }));
  await page.goto(`/translation.html?paper=${PAPER_ID}&question=translation-1&page=1`);
  await expect(page.locator('#apply-translation-answer')).toBeEnabled();
  return control;
}

test('translation streams real method analysis with cancellation and explicit memory reset', async ({ page }) => {
  await mockStream(page, { final: false, hold: true, deltas: ['翻译未完成片段'] });
  const control = await translationPage(page);
  await page.locator('#translation-revised-text').fill('As our study deepens, we express ourselves more accurately.');
  await page.locator('#translation-ai-input').fill('先提示'); await page.locator('#translation-ai-input').press('Enter');
  await expect(page.locator('#translation-ai-runtime')).toContainText('LangGraph 已就绪');
  await expect(page.locator('#translation-ai-reply')).toContainText('未完成片段');
  await page.locator('#stop-translation-ai').click(); await expect(page.locator('#translation-ai-state')).toContainText('已停止');
  await expect(page.locator('#translation-ai-input')).toHaveValue('先提示');
  const clears = []; await page.route(`**${API_ROOT}/assistant/conversations/clear`, (route) => { clears.push(route.request().postDataJSON()); return route.fulfill({ json: { cleared: true } }); });
  await page.locator('#new-translation-ai').click(); await expect(page.locator('#translation-ai-reply')).toBeEmpty();
  expect(clears[0].scope).toBe('question'); expect(clears[0].questionId).toBe('translation-1'); expect(clears[0].conversationId).toMatch(UUID);
  expect(control.pageErrors).toEqual([]); expect(control.outsideRequests).toEqual([]); expect(control.requests).toEqual([]);
});

test('translation revoking personal consent rotates UUID and never reuses authorized history after reload', async ({ page }) => {
  const control = await translationPage(page);
  await page.route('**/api/exams/capabilities', (route) => route.fulfill({ json: { agent: { ...READY, streaming: false, memory: false } } }));
  await page.reload(); await expect(page.locator('#apply-translation-answer')).toBeEnabled();
  await page.locator('#translation-method-source').fill('PRIVATE_METHOD'); await page.locator('#translation-revised-text').fill('My translation.');
  await page.locator('#translation-ai-consent').check(); await page.locator('[data-translation-ai="hint"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议'); const authorizedId = control.requests.at(-1).body.conversationId;
  await page.reload(); await expect(page.locator('#apply-translation-answer')).toBeEnabled(); await page.locator('#translation-revised-text').fill('My current translation.');
  await expect(page.locator('#translation-ai-consent')).not.toBeChecked();
  await page.locator('[data-translation-ai="hint"]').click(); await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  const publicBody = control.requests.at(-1).body; expect(publicBody.conversationId).not.toBe(authorizedId); expect(publicBody.history).toEqual([]); expect(JSON.stringify(publicBody)).not.toContain('PRIVATE_METHOD');
});

test('withdrawing personal consent clears the exact old server memory and cancels an authorized stream', async ({ page }) => {
  await mockStream(page, { final: false, hold: true, deltas: ['PRIVATE_UNFINISHED_REPLY'] });
  const control = await translationPage(page);
  const clears = []; await page.route(`**${API_ROOT}/assistant/conversations/clear`, (route) => { clears.push(route.request().postDataJSON()); return route.fulfill({ json: { cleared: true } }); });
  await page.locator('#translation-revised-text').fill('My current translation.');
  await page.locator('#translation-ai-consent').check(); await page.locator('[data-translation-ai="hint"]').click();
  await expect(page.locator('#translation-ai-reply')).toContainText('PRIVATE_UNFINISHED_REPLY');
  const oldId = await page.evaluate(() => window.__streamRequests[0].conversationId);
  await page.locator('#translation-ai-consent').uncheck();
  await expect(page.locator('#translation-ai-state')).toContainText('删除旧服务端会话记忆');
  await expect(page.locator('#send-translation-ai')).toBeEnabled();
  await expect(page.locator('#translation-ai-reply')).toBeEmpty();
  expect(clears).toEqual([{ conversationId: oldId, scope: 'question', questionId: 'translation-1' }]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cet:translation-ai:browser-fixture:question:translation-1:v1')));
  expect(saved['question:translation-1']).not.toBe(oldId); expect(saved._pendingMemoryClears).toEqual([]);
  expect(control.requests).toEqual([]); expect(await page.evaluate(() => window.__streamRequests.length)).toBe(1);
});

test('failed withdrawal purge remains explicit and new chat retries deletion without reusing personal history', async ({ page }) => {
  const control = await translationPage(page);
  await page.route('**/api/exams/capabilities', (route) => route.fulfill({ json: { agent: { ...READY, streaming: false } } }));
  await page.reload(); await expect(page.locator('#apply-translation-answer')).toBeEnabled();
  let fail = true; const clears = [];
  await page.route(`**${API_ROOT}/assistant/conversations/clear`, (route) => { const body = route.request().postDataJSON(); clears.push(body); return route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { cleared: true } }); });
  await page.locator('#translation-method-source').fill('PRIVATE_METHOD'); await page.locator('#translation-revised-text').fill('My translation.');
  await page.locator('#translation-ai-consent').check(); await page.locator('[data-translation-ai="hint"]').click();
  await expect(page.locator('#translation-ai-state')).toContainText('辅助建议'); const oldId = control.requests.at(-1).body.conversationId;
  await page.locator('#translation-ai-consent').uncheck(); await expect(page.locator('#translation-ai-state')).toContainText('旧服务端摘要未删除');
  await expect(page.locator('#translation-ai-reply')).toBeEmpty();
  await page.locator('[data-translation-ai="hint"]').click(); await expect(page.locator('#translation-ai-state')).toContainText('辅助建议');
  const clean = control.requests.at(-1).body; expect(clean.conversationId).not.toBe(oldId); expect(clean.history).toEqual([]); expect(JSON.stringify(clean)).not.toContain('PRIVATE_METHOD');
  fail = false; await page.locator('#new-translation-ai').click(); await expect(page.locator('#translation-ai-state')).toContainText('已开始新的对话');
  expect(clears.filter((body) => body.conversationId === oldId)).toHaveLength(2);
  expect(clears.every((body) => body.scope === 'question' && body.questionId === 'translation-1')).toBeTruthy();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cet:translation-ai:browser-fixture:question:translation-1:v1')));
  expect(saved._pendingMemoryClears).toEqual([]); expect(control.pageErrors).toEqual([]);
});
