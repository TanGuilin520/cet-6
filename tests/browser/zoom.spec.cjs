const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT } = require('./reader-fixture.cjs');

// Compare the actual PDF rectangle, not the shell containing question controls.
// All documents and question APIs are synthetic; no AI request is needed.
async function centers(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('#document-viewport');
    const box = viewport.getBoundingClientRect();
    const visibleCenter = box.left + viewport.clientLeft + viewport.clientWidth / 2;
    return [...document.querySelectorAll('.pdf-page-surface')].map((surface) => {
      const paper = surface.getBoundingClientRect();
      return Math.abs(paper.left + paper.width / 2 - visibleCenter);
    });
  });
}

async function expectCentered(page) {
  await expect.poll(async () => Math.max(...await centers(page)), {
    message: 'Every PDF surface stays centered within the visible document viewport',
  }).toBeLessThanOrEqual(2);
}

async function changeZoom(page, button, count = 1) {
  for (let index = 0; index < count; index += 1) {
    await page.locator(button).click();
    await expectCentered(page);
  }
}

async function setupMultiPageReader(page) {
  const control = await setupReader(page);
  await page.route(`**${API_ROOT}/manifest`, (route) => route.fulfill({ json: {
    title: 'Synthetic mixed-size paper', pageCount: 3,
    pages: [
      { number: 1, width: 595, height: 842 },
      { number: 2, width: 842, height: 1190 },
      { number: 3, width: 420, height: 1000 },
    ].map((paper) => ({ ...paper, image: `synthetic-page-${paper.number}.png`,
      words: paper.number === 1 ? ['Learning', 'English', 'takes', 'practice.'].map((text, index) => ({
        id: index + 1, text, line: 1, x: 145 + index * 68, y: 120, width: 63, height: 20,
      })) : [],
    })),
  } }));
  await page.reload();
  await expect(page.locator('.pdf-page-surface')).toHaveCount(3);
  await expect(page.locator('#question-navigator button')).toHaveCount(2);
  await expect(page.locator('#viewer-loading')).toBeHidden();
  return control;
}

test('fit, repeated zoom in, zoom out and fit keep the PDF centered with question controls', async ({ page }) => {
  const control = await setupReader(page);
  await page.locator('#fit-width').click();
  await expectCentered(page);
  await changeZoom(page, '#zoom-in', 4);
  await changeZoom(page, '#zoom-out', 6);
  await page.locator('#fit-width').click();
  await expectCentered(page);
  await expect(page.locator('#zoom-value')).toHaveText('适合宽度');
  expect(control.requests).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('a paper without question controls uses the same centered zoom behavior', async ({ page }) => {
  const control = await setupReader(page, { questions: [] });
  await expectCentered(page);
  await changeZoom(page, '#zoom-in', 3);
  await changeZoom(page, '#zoom-out', 5);
  await page.locator('#fit-width').click();
  await expectCentered(page);
  expect(control.pageErrors).toEqual([]);
});

test('opening and closing the thumbnail and note sidebars recenters the PDF', async ({ page }) => {
  await setupReader(page);
  await changeZoom(page, '#zoom-in', 2);
  for (const button of ['#toggle-thumbnails', '#toggle-notes', '#toggle-thumbnails', '#toggle-notes']) {
    await page.locator(button).click();
    await expectCentered(page);
  }
  await changeZoom(page, '#zoom-out', 2);
  await expectCentered(page);
});

test('different page sizes share the visible viewport center while zooming and resizing', async ({ page }) => {
  const control = await setupMultiPageReader(page);
  await expectCentered(page);
  await changeZoom(page, '#zoom-in', 3);
  await page.setViewportSize({ width: 1080, height: 900 });
  await expectCentered(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectCentered(page);
  await page.locator('#fit-width').click();
  await expectCentered(page);
  expect(control.requests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('mobile overflow is symmetric and a later zoom recenters after manual horizontal panning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await setupReader(page);
  await expectCentered(page);
  await changeZoom(page, '#zoom-in', 4);
  await expect.poll(() => page.locator('#document-viewport').evaluate((viewport) =>
    viewport.scrollWidth - viewport.clientWidth)).toBeGreaterThan(40);
  await page.locator('#document-viewport').evaluate((viewport) => { viewport.scrollLeft = 0; });
  expect(Math.max(...await centers(page))).toBeGreaterThan(10);
  await changeZoom(page, '#zoom-out');
  await changeZoom(page, '#zoom-out', 3);
  await expect(page.locator('#zoom-value')).toHaveText('适合宽度');
  await page.setViewportSize({ width: 844, height: 390 });
  await expectCentered(page);
  expect(control.requests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('zooming midway through a long paper retains the visible page and vertical reading position', async ({ page }) => {
  await setupMultiPageReader(page);
  await page.evaluate(() => {
    const viewport = document.querySelector('#document-viewport');
    const surface = document.querySelector('.pdf-page-shell[data-page="2"] .pdf-page-surface');
    const box = viewport.getBoundingClientRect();
    const paper = surface.getBoundingClientRect();
    viewport.scrollTop += paper.top + paper.height * 0.55 - box.top - viewport.clientTop - viewport.clientHeight / 2;
  });
  const position = () => page.evaluate(() => {
    const viewport = document.querySelector('#document-viewport');
    const box = viewport.getBoundingClientRect();
    const centerY = box.top + viewport.clientTop + viewport.clientHeight / 2;
    const paper = document.querySelector('.pdf-page-shell[data-page="2"] .pdf-page-surface').getBoundingClientRect();
    return { ratio: (centerY - paper.top) / paper.height, scrollTop: viewport.scrollTop };
  });
  await expect.poll(async () => (await position()).ratio).toBeCloseTo(0.55, 2);
  const before = await position();
  await changeZoom(page, '#zoom-in', 2);
  await expect.poll(async () => Math.abs((await position()).ratio - before.ratio)).toBeLessThan(0.005);
  expect((await position()).scrollTop).toBeGreaterThan(300);
  await changeZoom(page, '#zoom-out', 2);
  await expect.poll(async () => Math.abs((await position()).ratio - before.ratio)).toBeLessThan(0.005);
  expect((await position()).scrollTop).toBeGreaterThan(300);
});
