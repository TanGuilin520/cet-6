const { test, expect } = require('@playwright/test');
const { setupReader, selectPdfWords } = require('./reader-fixture.cjs');

const TOOLBAR = '#selection-toolbar';
const RECORDS = '#tag-record-list [data-record-tag-id]';
const HIGHLIGHTS = '.page-markup-layer .mark-highlight';

function action(page, name) {
  return page.locator(`${TOOLBAR} [data-selection-action="${name}"]`);
}

async function selectForAction(page) {
  const text = await selectPdfWords(page);
  await expect(page.locator(TOOLBAR)).toHaveClass(/is-visible/);
  return text;
}

async function startNote(page) {
  const quote = await selectForAction(page);
  await action(page, 'note').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#selected-quote')).toContainText(quote);
  return quote;
}

test('mouse selection shows a compact toolbar without opening or focusing the note editor', async ({ page }) => {
  const control = await setupReader(page);
  // Question controls add their gutter after the PDF loads; wait for the
  // shell's real sizing transition before using screen coordinates.
  await page.locator('.pdf-page-shell').evaluate(async (shell) => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await Promise.allSettled(shell.getAnimations().map((animation) => animation.finished));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const words = page.locator('.pdf-word');
  const first = await words.first().boundingBox();
  const last = await words.last().boundingBox();
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 14 });
  await page.mouse.up();
  await expect(page.locator(TOOLBAR)).toHaveClass(/is-visible/);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator(RECORDS)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toContain('English');
  await expect(page.locator('#tag-note')).not.toBeFocused();
  await action(page, 'dismiss').click();
  await expect(page.locator(TOOLBAR)).not.toHaveClass(/is-visible/);
  expect(control.pageErrors).toEqual([]);
});

test('copy preserves the PDF selection and allows a note action on the same selection', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copiedSelection = text; } },
    });
  });
  await setupReader(page);
  const quote = await selectForAction(page);
  await action(page, 'copy').click();
  await expect.poll(() => page.evaluate(() => window.__copiedSelection)).toBe(quote);
  await expect(page.locator(TOOLBAR)).toHaveClass(/is-visible/);
  await expect.poll(() => page.evaluate(() => window.getSelection().toString().trim())).not.toBe('');
  await action(page, 'note').click();
  await expect(page.locator('#selected-quote')).toContainText(quote);
  await expect(page.locator('#tag-note')).toBeFocused();
});

test('selection toolbar opens AI in selection mode without sending a model request', async ({ page }) => {
  const control = await setupReader(page);
  const quote = await selectForAction(page);
  await action(page, 'ai').click();
  await expect(page.locator('#ai-question-panel')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('[data-ai-scope="selection"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ai-selection-excerpt')).toHaveText(quote);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  expect(control.requests).toEqual([]);
  expect(control.outsideRequests).toEqual([]);
});

test('a closed draft retains its long body and original anchor through a reload', async ({ page }) => {
  const control = await setupReader(page);
  const note = `学习记录\n${'保留原文依据与自己的理解。'.repeat(65)}\n最后一段不可丢失。`;
  const quote = await startNote(page);
  await page.locator('#tag-label').fill('');
  await page.locator('#tag-note').fill(note);
  await page.locator('#cancel-tag').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await expect(page.locator(RECORDS)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.pdf-word')).toHaveCount(4);
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#tag-note')).toHaveValue(note);
  await expect(page.locator('#selected-quote')).toContainText(quote);
  // A label is optional; keyboard save should commit the restored body.
  await page.locator('#tag-label').fill('');
  await page.locator('#tag-note').press('Control+Enter');
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await expect(page.locator(RECORDS).locator('b')).toHaveText('重点');
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toContainText('学习记录');
  await expect(page.locator('#resume-note-draft')).toBeHidden();
  await page.reload();
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await page.locator(RECORDS).click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#tag-note')).toHaveValue(note);
  await expect(page.locator('#selected-quote')).toContainText(quote);
  expect(control.pageErrors).toEqual([]);
});

test('discarding a draft removes its recovery entry without creating a saved note', async ({ page }) => {
  await setupReader(page);
  await startNote(page);
  await page.locator('#tag-note').fill('这份草稿需要明确丢弃');
  await page.locator('#cancel-tag').click();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toHaveValue('这份草稿需要明确丢弃');
  await page.locator('#discard-note-draft').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#resume-note-draft')).toBeHidden();
  await expect(page.locator(RECORDS)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.pdf-word')).toHaveCount(4);
  await expect(page.locator('#resume-note-draft')).toBeHidden();
  await startNote(page);
  await expect(page.locator('#tag-note')).toHaveValue('');
});

test('switching selected passages keeps separate drafts and saving one preserves the other', async ({ page }) => {
  await setupReader(page);
  const firstQuote = await startNote(page);
  await page.locator('#tag-note').fill('整句话的第一份草稿');
  await page.locator('#cancel-tag').click();
  const secondQuote = await page.evaluate(() => {
    const words = [...document.querySelectorAll('#document-pages .pdf-word')];
    const range = document.createRange();
    range.setStart(words[1].firstChild, 0);
    range.setEnd(words[2].firstChild, words[2].textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const box = words[1].getBoundingClientRect();
    words[1].dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: box.x + 4, clientY: box.y + 4, pointerType: 'mouse',
    }));
    return text;
  });
  await expect(page.locator(TOOLBAR)).toHaveClass(/is-visible/);
  await action(page, 'note').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#tag-note')).toHaveValue('');
  await expect(page.locator('#selected-quote')).toContainText(secondQuote);
  await page.locator('#tag-note').fill('另一段文字的第二份草稿');
  await page.locator('#cancel-tag').click();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toHaveValue('另一段文字的第二份草稿');
  await expect(page.locator('#selected-quote')).toContainText(secondQuote);
  await page.locator('#save-tag').click();
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toHaveText('另一段文字的第二份草稿');
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toHaveValue('整句话的第一份草稿');
  await expect(page.locator('#selected-quote')).toContainText(firstQuote);
});

test('editing a saved note changes one record and undo/redo restores the previous body', async ({ page }) => {
  await setupReader(page);
  await startNote(page);
  await page.locator('#tag-note').fill('原始笔记正文');
  await page.locator('#save-tag').click();
  await expect(page.locator(RECORDS)).toHaveCount(1);
  const id = await page.locator(RECORDS).getAttribute('data-record-tag-id');
  await page.locator(RECORDS).click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await page.locator('#tag-note').fill('修改后的笔记正文');
  await page.locator('#save-tag').click();
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await expect(page.locator(RECORDS)).toHaveAttribute('data-record-tag-id', id);
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toHaveText('修改后的笔记正文');
  await page.locator('#undo-mark').click();
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toHaveText('原始笔记正文');
  await page.locator('#redo-mark').click();
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toHaveText('修改后的笔记正文');
  await page.locator('#undo-mark').click();
  await page.locator('#undo-mark').click();
  await expect(page.locator(RECORDS)).toHaveCount(0);
  await page.locator('#redo-mark').click();
  await expect(page.locator(RECORDS).locator('.tag-record-note')).toHaveText('原始笔记正文');
});

test('annotation undo shortcuts do not delete records while typing a note', async ({ page }) => {
  await setupReader(page);
  await startNote(page);
  await page.locator('#tag-note').fill('已经保存的记录');
  await page.locator('#save-tag').click();
  await page.locator(RECORDS).click();
  const input = page.locator('#tag-note');
  await input.press('Control+End');
  await input.pressSequentially(' 临时编辑');
  await input.press('Control+z');
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
  await input.press('Control+Shift+z');
  await expect(page.locator(RECORDS)).toHaveCount(1);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
});

test('toolbar highlights use the selected color and support undo and redo', async ({ page }) => {
  await setupReader(page);
  await selectForAction(page);
  await page.locator('#selection-highlight-color').fill('#72e3a2');
  await action(page, 'highlight').click();
  await expect(page.locator(HIGHLIGHTS)).toHaveCount(1);
  await expect(page.locator(HIGHLIGHTS)).toHaveAttribute('style', /#72e3a2/i);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('#undo-mark').click();
  await expect(page.locator(HIGHLIGHTS)).toHaveCount(0);
  await page.locator('#redo-mark').click();
  await expect(page.locator(HIGHLIGHTS)).toHaveCount(1);
  await expect(page.locator(HIGHLIGHTS)).toHaveAttribute('style', /#72e3a2/i);
});

test('continuous highlighter still marks immediately without requiring a toolbar action', async ({ page }) => {
  await setupReader(page);
  await page.locator('[data-tool="highlight"]').click();
  await selectPdfWords(page);
  await expect(page.locator(HIGHLIGHTS)).toHaveCount(1);
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator(TOOLBAR)).not.toHaveClass(/is-visible/);
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe('');
});
