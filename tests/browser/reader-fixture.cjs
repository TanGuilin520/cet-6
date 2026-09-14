const { expect } = require('@playwright/test');

const PAPER_ID = 'browser-fixture';
const API_ROOT = `/api/exams/${PAPER_ID}`;
const INPUT = '#ai-question-input';
const MESSAGES = '#ai-question-messages';
const ASSISTANT_BODIES = `${MESSAGES} .ai-md-body`;
const USER_MESSAGES = `${MESSAGES} .ai-question-message--user`;
const transparentImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=',
  'base64',
);

function defaultQuestions() {
  return [1, 2].map((number) => ({
    questionId: `q${number}`, number, type: 'single_choice', page: 1,
    stem: `Synthetic question ${number}: What helps people learn?`,
    bbox: { x: 140, y: 170 + number * 130, width: 300, height: 100 },
    options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} synthetic option` })),
    confidence: 0.99,
  }));
}

function modelReply(body, reply = `## 学习建议\n\n收到：${body.message}`) {
  return {
    scope: body.scope,
    questionId: body.questionId || null,
    requestId: body.requestId,
    revision: 1,
    reply,
    citations: [],
    grounding: { officialExplanationFound: false, disclaimerRequired: body.scope === 'question' },
    generation: {
      provider: 'deepseek', model: 'offline-browser-fixture', attempted: true, used: true,
      fallbackReason: null, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    },
  };
}

async function setupReader(page, { questions = defaultQuestions(), respond } = {}) {
  const control = { requests: [], outsideRequests: [], pageErrors: [], respond };
  page.on('pageerror', (error) => control.pageErrors.push(error.message));
  // Every non-loopback request is aborted; no user paper or answer PDF is used.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      control.outsideRequests.push(request.url());
      return route.abort('blockedbyclient');
    }
    if (url.pathname === `${API_ROOT}/manifest`) {
      const text = ['Learning', 'English', 'takes', 'practice.'];
      return route.fulfill({ json: {
        title: 'Synthetic browser regression paper', pageCount: 1,
        pages: [{ number: 1, width: 595, height: 842, image: 'test-page.png',
          words: text.map((word, index) => ({
            id: index + 1, text: word, line: 1, x: 145 + index * 68, y: 120,
            width: 63, height: 20,
          })),
        }],
      } });
    }
    if (url.pathname === `${API_ROOT}/questions`) {
      return route.fulfill({ headers: { ETag: '"review-r1"' }, json: { revision: 1, questions } });
    }
    if (url.pathname === `${API_ROOT}/answers`) {
      return route.fulfill({ json: { revision: 1, answers: [] } });
    }
    if (url.pathname === `${API_ROOT}/assistant`) {
      const body = request.postDataJSON();
      control.requests.push({ body, bytes: Buffer.byteLength(request.postData() || '', 'utf8') });
      if (control.respond) return control.respond(route, body, control.requests.length);
      return route.fulfill({ json: modelReply(body) });
    }
    if (/\.(?:jpg|png|ico)$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/png', body: transparentImage });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'No synthetic fixture' } });
    return route.continue();
  });
  await page.goto(`/reader.html?paper=${PAPER_ID}`);
  await expect(page.locator('.pdf-word')).toHaveCount(4);
  await expect(page.locator('#question-navigator button')).toHaveCount(questions.length);
  await expect(page.locator('#viewer-loading')).toBeHidden();
  return control;
}

async function openChat(page, scope = 'general') {
  await page.locator('#ai-floating-launcher').click();
  await expect(page.locator('#ai-question-panel')).toHaveAttribute('aria-hidden', 'false');
  const tab = page.locator(`[data-ai-scope="${scope}"]`);
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function sendMessage(page, message) {
  await page.locator(INPUT).fill(message);
  await page.locator(INPUT).press('Enter');
  await expect(page.locator('#ai-send-button')).toBeEnabled();
}

async function selectPdfWords(page) {
  return page.evaluate(() => {
    const words = [...document.querySelectorAll('#document-pages .pdf-word')];
    const range = document.createRange();
    range.setStart(words[0].firstChild, 0);
    range.setEnd(words[words.length - 1].firstChild, words[words.length - 1].textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const box = words[0].getBoundingClientRect();
    words[0].dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: box.x + 4, clientY: box.y + 4, pointerType: 'mouse',
    }));
    return text;
  });
}

module.exports = {
  API_ROOT, PAPER_ID, INPUT, MESSAGES, ASSISTANT_BODIES, USER_MESSAGES,
  setupReader, openChat, sendMessage, selectPdfWords, modelReply,
};
