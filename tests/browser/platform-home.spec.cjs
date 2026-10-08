const { test, expect } = require('@playwright/test');

const FIRST_ID = 'exam-20261007-aaaaaaaaaaaa';
const SECOND_ID = 'exam-20261007-bbbbbbbbbbbb';
// This used to identify the built-in paper and suppress matching user uploads.
const SHARED_SOURCE_SHA = '688e243765c218d42d2a5fc5b54adb34247e6b3549da0a86ad2a39623d03a670';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=',
  'base64',
);

function uploadedExam(examId, title, overrides = {}) {
  return {
    examId, title, status: 'ready', createdAt: '2026-10-07T08:00:00Z',
    paperSha256: SHARED_SOURCE_SHA, questionCount: 8, answerCount: 8,
    hasAudio: false, hasAnswer: true, ...overrides,
  };
}

async function installPlatformFixtures(page, { exams = [], catalogResponse } = {}) {
  const control = { catalogRequests: 0, apiRequests: [], outsideRequests: [], pageErrors: [] };
  page.on('pageerror', (error) => control.pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      control.outsideRequests.push(request.url());
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) control.apiRequests.push(url.pathname);
    if (url.pathname === '/api/exams') {
      control.catalogRequests += 1;
      if (catalogResponse) return catalogResponse(route, control.catalogRequests);
      return route.fulfill({ json: { exams } });
    }
    const exam = exams.find((item) => url.pathname.startsWith(`/api/exams/${item.examId}/`));
    if (exam?.status === 'ready' && url.pathname.endsWith('/manifest')) {
      return route.fulfill({ json: {
        title: exam.title, pageCount: 1,
        pages: [{ number: 1, width: 595, height: 842, image: 'synthetic-page.png',
          words: [{ id: 1, text: 'Practice', line: 1, x: 140, y: 120, width: 70, height: 20 }],
        }],
      } });
    }
    if (exam?.status === 'ready' && url.pathname.endsWith('/questions')) {
      return route.fulfill({ headers: { ETag: '"review-r1"' }, json: {
        revision: 1, questions: [{
          questionId: 'q1', number: 1, type: 'single_choice', page: 1,
          stem: 'Synthetic practice question', confidence: 0.99,
          bbox: { x: 140, y: 170, width: 300, height: 100 },
          options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} option` })),
        }],
      } });
    }
    if (exam?.status === 'ready' && url.pathname.endsWith('/answers')) {
      return route.fulfill({ json: { revision: 1, answers: [] } });
    }
    if (/\.(?:jpg|png|ico)$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/png', body: PIXEL });
    }
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 404, json: { error: 'No synthetic fixture for this resource' } });
    }
    return route.continue();
  });
  return control;
}

function expectCleanBrowser(control) {
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
}

test('an empty platform offers upload without a built-in exam or invented progress', async ({ page }) => {
  const control = await installPlatformFixtures(page);
  await page.goto('/');
  await expect.poll(() => control.catalogRequests).toBe(1);
  await expect(page.locator('#paper-total')).toHaveText('0');
  await expect(page.locator('.paper-card')).toHaveCount(0);
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#hero-upload')).toHaveAttribute('href', 'upload.html');
  await expect(page.locator('#empty-upload')).toHaveAttribute('href', 'upload.html');
  await expect(page.locator('.continue-button')).toBeDisabled();
  await expect(page.locator('#continue-value')).toHaveText('暂无记录');
  await expect(page.locator('body')).not.toContainText('47 题');
  await expect(page.locator('body')).not.toContainText('2021 年 6 月');
  await expect(page.locator('body')).not.toContainText('CET-4');
  await expect(page.locator('body')).not.toContainText('四级真题');
  expectCleanBrowser(control);
});

test('stale built-in progress does not create a continuation target in an empty platform', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('exam-viewer:2021-06-01:v1', JSON.stringify({ answers: { q1: 'A' } }));
  });
  const control = await installPlatformFixtures(page);
  await page.goto('/');
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('.continue-button')).toBeDisabled();
  await expect(page.locator('[data-paper-id="2021-06-01"], [data-open-paper="2021-06-01"]')).toHaveCount(0);
  await expect(page.locator('#paper-total')).toHaveText('0');
  expectCleanBrowser(control);
});

test('ready uploads with the same source remain separate while unfinished uploads are excluded', async ({ page }) => {
  const exams = [
    uploadedExam(FIRST_ID, '我的第一套英语练习'),
    uploadedExam(SECOND_ID, '同一原卷的第二份练习', { questionCount: 11, hasAudio: true }),
    uploadedExam('exam-20261007-cccccccccccc', '尚在解析的练习', { status: 'processing' }),
    uploadedExam('exam-20261007-dddddddddddd', '解析失败的练习', { status: 'failed' }),
  ];
  const control = await installPlatformFixtures(page, { exams });
  await page.goto('/');
  await expect(page.locator('.paper-card')).toHaveCount(2);
  await expect(page.locator('#paper-total')).toHaveText('2');
  await expect(page.locator(`[data-open-paper="${FIRST_ID}"]`)).toBeVisible();
  await expect(page.locator(`[data-open-paper="${SECOND_ID}"]`)).toBeVisible();
  await expect(page.locator('#paper-groups')).not.toContainText('尚在解析的练习');
  await expect(page.locator('#paper-groups')).not.toContainText('解析失败的练习');
  await expect(page.locator('#paper-groups')).not.toContainText('47 题');
  await expect(page.locator('#catalog-error')).toBeHidden();
  expectCleanBrowser(control);
});

test('catalog failure shows retry and never substitutes a demonstration exam', async ({ page }) => {
  const exam = uploadedExam(FIRST_ID, '重试后载入的个人试卷');
  const control = await installPlatformFixtures(page, { catalogResponse: (route, attempt) => (
    attempt === 1
      ? route.fulfill({ status: 503, json: { error: 'Synthetic catalog unavailable' } })
      : route.fulfill({ json: { exams: [exam] } })
  ) });
  await page.goto('/');
  await expect(page.locator('#catalog-error')).toBeVisible();
  await expect(page.locator('#retry-exams')).toBeVisible();
  await expect(page.locator('.paper-card')).toHaveCount(0);
  await expect(page.locator('#paper-total')).toHaveText('0');
  await expect(page.locator('.continue-button')).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('2021 年 6 月');
  await page.locator('#retry-exams').click();
  await expect(page.locator(`[data-open-paper="${FIRST_ID}"]`)).toBeVisible();
  await expect(page.locator('#catalog-error')).toBeHidden();
  await expect(page.locator('#paper-total')).toHaveText('1');
  expect(control.catalogRequests).toBe(2);
  expectCleanBrowser(control);
});

test('an uploaded card opens that upload in the shared reader', async ({ page }) => {
  const exam = uploadedExam(FIRST_ID, '用户上传的独立英语试卷');
  const control = await installPlatformFixtures(page, { exams: [exam] });
  await page.goto('/');
  await page.locator(`[data-open-paper="${FIRST_ID}"]`).click();
  await expect(page.locator('#paper-dialog')).toBeVisible();
  await expect(page.locator('#dialog-paper-title')).toHaveText(exam.title);
  await page.locator(`[data-start-paper="${FIRST_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/reader\\.html\\?paper=${FIRST_ID}(?:&|$)`));
  await expect(page.locator('#paper-title')).toHaveText(exam.title);
  await expect(page.locator('.pdf-word')).toHaveCount(1);
  expect(control.apiRequests).toContain(`/api/exams/${FIRST_ID}/manifest`);
  expect(control.apiRequests.some((path) => path.startsWith('/api/papers/'))).toBe(false);
  expectCleanBrowser(control);
});

test('a reader opened without an upload redirects to the upload page', async ({ page }) => {
  const control = await installPlatformFixtures(page);
  await page.goto('/reader.html');
  await expect(page).toHaveURL(/\/upload\.html(?:\?|$)/);
  expect(control.apiRequests.some((path) => path.startsWith('/api/papers/'))).toBe(false);
  expectCleanBrowser(control);
});

test('an old built-in reader link offers upload instead of silently loading a demo', async ({ page }) => {
  const control = await installPlatformFixtures(page);
  await page.goto('/reader.html?paper=2021-06-01');
  await expect(page.locator('#viewer-loading')).toBeVisible();
  await expect(page.locator('#viewer-loading a[href="upload.html"]')).toBeVisible();
  await expect(page.locator('#viewer-loading')).toContainText(/上传|导入/);
  await expect(page.locator('.pdf-page-shell')).toHaveCount(0);
  await expect(page.locator('.viewer-loading-preview[src*="2021-06"]')).toHaveCount(0);
  expectCleanBrowser(control);
});
