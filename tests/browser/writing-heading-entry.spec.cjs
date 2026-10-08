const { test, expect } = require('@playwright/test');
const { setupReader, API_ROOT, PAPER_ID } = require('./reader-fixture.cjs');

const PAGE_WIDTH = 595.32;
const HEADING_Y = 95.628;

function headingWords() {
  // PDF text extraction may assign three separate line IDs to one visual row.
  // In particular, the Writing title must work without a parsed writing QID.
  return [
    { text: 'Part', line: 1, x: 42.6, y: HEADING_Y, width: 22.653, height: 13.284 },
    { text: 'I', line: 1, x: 69.6, y: HEADING_Y, width: 4.668, height: 13.284 },
    { text: 'Writing', line: 2, x: 264, y: HEADING_Y, width: 40.598, height: 13.284 },
    { text: '(30', line: 3, x: 486.127, y: HEADING_Y, width: 15.997, height: 13.284 },
    { text: 'minutes)', line: 3, x: 505.08, y: HEADING_Y, width: 44.642, height: 13.284 },
    { text: 'Directions:', line: 4, x: 42.6, y: 112.923, width: 51.789, height: 12.222 },
    { text: 'Write', line: 4, x: 99.24, y: 112.923, width: 24, height: 12.222 },
    { text: 'an', line: 4, x: 129, y: 112.923, width: 12, height: 12.222 },
    { text: 'essay.', line: 4, x: 147, y: 112.923, width: 28, height: 12.222 },
  ].map((word, id) => ({ id, ...word }));
}

function readingQuestion() {
  return {
    questionId: 'q1', number: 1, type: 'single_choice', page: 1,
    stem: 'Synthetic reading question: Which activity helps students learn?',
    bbox: { x: 140, y: 350, width: 300, height: 100 },
    options: ['A', 'B', 'C', 'D'].map((label) => ({ label, text: `${label} synthetic option` })),
    confidence: 0.99,
  };
}

async function setupWritingHeading(page, words = headingWords()) {
  const control = await setupReader(page, { questions: [readingQuestion()] });
  await page.route(`**${API_ROOT}/manifest`, (route) => route.fulfill({ json: {
    title: 'Synthetic split-line Writing heading regression', pageCount: 1,
    pages: [{ number: 1, width: PAGE_WIDTH, height: 841.92,
      image: 'writing-heading.png', words }],
  } }));
  await page.reload();
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator('.pdf-word')).toHaveCount(words.length);
  await expect(page.locator('#question-navigator button')).toHaveCount(1);
  return control;
}

function writingEntry(page) {
  return page.locator('.pdf-page-shell[data-page="1"] a[data-open-page-module="writing"]');
}

async function expectAdjacentClickableEntry(page) {
  const entry = writingEntry(page);
  await expect(entry).toBeVisible();
  await entry.scrollIntoViewIfNeeded();
  await expect.poll(() => entry.evaluate((link, dimensions) => {
    const surface = link.closest('.pdf-page-surface');
    const button = link.getBoundingClientRect();
    const paper = surface.getBoundingClientRect();
    const scale = paper.width / dimensions.width;
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return {
      gap: Math.abs(paper.left - button.right - 8) <= 1.5,
      aligned: Math.abs((button.top - paper.top) / scale - dimensions.y) <= 1.5,
      width: button.width >= 43.5 && button.width <= 81,
      height: button.height >= 35.5 && button.height <= 37,
      outsidePaper: button.right <= paper.left,
      clickable: hit === link || Boolean(hit && link.contains(hit)),
    };
  }, { width: PAGE_WIDTH, y: HEADING_Y }), {
    message: 'The Writing shortcut stays 8 physical pixels outside its PDF heading and is a distinct clickable target',
  }).toEqual({ gap: true, aligned: true, width: true, height: true, outsidePaper: true, clickable: true });
}

for (const [name, size] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  test(`${name}: an unparsed split-line Writing heading opens templates beside the PDF and returns to its page`, async ({ page }) => {
    await page.setViewportSize(size);
    const control = await setupWritingHeading(page);
    const entry = writingEntry(page);
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveClass(/page-module-link--writing-heading/);
    await expect(entry).toHaveAccessibleName(/^进入作文模板，第 1 页$/);
    await expect(entry).toHaveAttribute('data-module-question', '');
    await expect(entry).not.toHaveAttribute('data-open-writing-template', /./);
    await expectAdjacentClickableEntry(page);

    for (const zoom of ['#zoom-out', '#zoom-out', '#zoom-in', '#zoom-in', '#zoom-in', '#zoom-in']) {
      await page.locator(zoom).click();
      await expectAdjacentClickableEntry(page);
    }
    const destination = new URL(await entry.evaluate((link) => link.href));
    expect(destination.pathname).toBe('/writing.html');
    expect(destination.searchParams.get('paper')).toBe(PAPER_ID);
    expect(destination.searchParams.get('page')).toBe('1');
    expect(destination.searchParams.get('question')).toBeNull();
    await entry.click();
    await expect(page.locator('#writing-paragraph-intro')).toBeVisible();
    const back = page.locator('#back-to-reader');
    const returnUrl = new URL(await back.evaluate((link) => link.href));
    expect(returnUrl.pathname).toBe('/reader.html');
    expect(returnUrl.searchParams.get('paper')).toBe(PAPER_ID);
    expect(returnUrl.searchParams.get('page')).toBe('1');
    expect(returnUrl.searchParams.get('question')).toBeNull();
    await back.click();
    await expect(page.locator('#viewer-loading')).toBeHidden();
    await expect(page.locator('#current-page')).toHaveValue('1');
    await expectAdjacentClickableEntry(page);
    expect(control.pageErrors).toEqual([]);
    expect(control.outsideRequests).toEqual([]);
    expect(control.requests).toEqual([]);
  });
}

test('Writing inside a prose sentence never creates a shortcut or a made-up writing question', async ({ page }) => {
  const words = ['Writing', 'English', 'requires', 'practice.'].map((text, id) => ({
    id, text, line: 1, x: 90 + id * 65, y: HEADING_Y, width: 60, height: 13.284,
  }));
  const control = await setupWritingHeading(page, words);
  await expect(writingEntry(page)).toHaveCount(0);
  await expect(page.locator('#question-navigator [data-navigate-question]')).toHaveCount(1);
  await expect(page.locator('[data-navigate-question="q1"]')).toBeVisible();
  expect(control.pageErrors).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
  expect(control.requests).toEqual([]);
});
