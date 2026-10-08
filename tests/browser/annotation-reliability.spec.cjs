const { test, expect } = require('@playwright/test');
const { setupReader, selectPdfWords, PAPER_ID } = require('./reader-fixture.cjs');

test('a failed note save retains the editor and draft until storage recovers', async ({ page }) => {
  await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="note"]').click();
  await page.locator('#tag-note').fill('存储空间不足时也不能丢掉这段笔记');
  await page.evaluate((paper) => {
    window.__originalStorageWrite = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === `exam-viewer:${paper}:v1`) throw new DOMException('Synthetic storage quota', 'QuotaExceededError');
      return window.__originalStorageWrite.call(this, key, value);
    };
  }, PAPER_ID);
  await page.locator('#save-tag').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#tag-note')).toHaveValue('存储空间不足时也不能丢掉这段笔记');
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await expect(page.locator('#tag-record-list [data-record-tag-id]')).toHaveCount(0);
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageWrite; });
  await page.locator('#save-tag').click();
  await expect(page.locator('#tag-record-list [data-record-tag-id]')).toHaveCount(1);
  await expect(page.locator('#resume-note-draft')).toBeHidden();
  await page.reload();
  await expect(page.locator('.tag-record-note')).toHaveText('存储空间不足时也不能丢掉这段笔记');
});

test('erasing many annotations keeps untouched marks and the note list stable during a gesture', async ({ page }) => {
  await page.addInitScript((paper) => {
    const annotations = Array.from({ length: 80 }, (_, index) => ({
      id: `fixture-highlight-${index}`, type: 'highlight', page: 1,
      rects: [{ x: 90 + (index % 4) * 110, y: 180 + Math.floor(index / 4) * 24, width: 70, height: 14 }],
      quote: 'Synthetic mark', wordIds: [], color: '#f6d64a', createdAt: index + 1,
    }));
    localStorage.setItem(`exam-viewer:${paper}:v1`, JSON.stringify({ tool: 'select', annotations }));
  }, PAPER_ID);
  await setupReader(page);
  await expect(page.locator('.mark-highlight')).toHaveCount(80);
  await page.locator('[data-tool="eraser"]').click();
  await page.evaluate(() => {
    window.__untouchedMark = document.querySelector('[data-annotation-id="fixture-highlight-79"]');
    window.__noteListBeforeGesture = document.querySelector('#tag-record-list').firstChild;
  });
  const first = await page.locator('[data-annotation-id="fixture-highlight-0"] rect').boundingBox();
  const second = await page.locator('[data-annotation-id="fixture-highlight-1"] rect').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 12 });
  await expect(page.locator('[data-annotation-id="fixture-highlight-0"]')).toHaveCount(0);
  await expect(page.locator('[data-annotation-id="fixture-highlight-1"]')).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.querySelector('[data-annotation-id="fixture-highlight-79"]') === window.__untouchedMark
      && document.querySelector('#tag-record-list').firstChild === window.__noteListBeforeGesture)).toBe(true);
  await page.mouse.up();
  const remaining = await page.locator('.mark-highlight').count();
  expect(remaining).toBeLessThan(80);
  await page.locator('#undo-mark').click();
  await expect(page.locator('.mark-highlight')).toHaveCount(80);
  await page.locator('#redo-mark').click();
  await expect(page.locator('.mark-highlight')).toHaveCount(remaining);
});

test('drawing a line finishes without leaving a preview and can be redone', async ({ page }) => {
  await setupReader(page);
  await page.locator('[data-tool="line"]').click();
  const layer = await page.locator('.page-markup-layer').boundingBox();
  await page.mouse.move(layer.x + 80, layer.y + 150);
  await page.mouse.down();
  await page.mouse.move(layer.x + 210, layer.y + 150, { steps: 15 });
  await page.mouse.up();
  await expect(page.locator('.mark-line-preview')).toHaveCount(0);
  await expect(page.locator('.mark-line')).toHaveCount(1);
  await page.locator('#undo-mark').click();
  await expect(page.locator('.mark-line')).toHaveCount(0);
  await page.locator('#redo-mark').click();
  await expect(page.locator('.mark-line')).toHaveCount(1);
});

test('the desktop note dock leaves room for the PDF and mobile notes remain editable', async ({ page }) => {
  await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="note"]').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  const viewport = await page.locator('#document-viewport').boundingBox();
  const editor = await page.locator('#tag-editor').boundingBox();
  expect(editor.x).toBeGreaterThanOrEqual(viewport.x + viewport.width);
  await page.locator('#tag-note').fill('桌面和手机宽度切换时保留正文');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tag-note')).toHaveValue('桌面和手机宽度切换时保留正文');
  await expect.poll(async () => {
    const box = await page.locator('#tag-editor').boundingBox();
    return box.x >= 0 && box.x + box.width <= 391;
  }).toBe(true);
  expect(await page.locator('#tag-note').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
  await page.locator('#save-tag').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
});

test('a delayed clipboard failure cannot replace a note opened in the meantime', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => new Promise((resolve, reject) => { window.__rejectClipboard = reject; }) } });
    document.execCommand = () => false;
  });
  const control = await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="copy"]').click();
  await page.locator('[data-selection-action="note"]').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await page.locator('#tag-note').fill('复制失败不能打断这条笔记');
  await page.evaluate(() => window.__rejectClipboard(new Error('Synthetic clipboard denial')));
  await expect(page.locator('#selection-copy-panel')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#tag-note')).toHaveValue('复制失败不能打断这条笔记');
  expect(control.pageErrors).toEqual([]);
});

test('a long passage draft retains its stable anchor after word IDs are normalized', async ({ page }) => {
  const note = '这条来自长篇选区的草稿必须完整恢复';
  await page.addInitScript(({ paper, note }) => {
    if (localStorage.getItem(`exam-viewer:${paper}:v1:note-drafts`)) return;
    const wordIds = Array.from({ length: 650 }, (_, index) => index + 1);
    localStorage.setItem(`exam-viewer:${paper}:v1:note-drafts`, JSON.stringify([{
      key: `selection:1:${wordIds.join(',')}`, tagId: '', page: 1, wordIds,
      rects: [{ x: 145, y: 120, width: 267, height: 20 }], quote: 'Synthetic long passage',
      label: '长难句', note, tone: 'blue', updatedAt: 1,
    }]));
  }, { paper: PAPER_ID, note });
  await setupReader(page);
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toHaveValue(note);
  await page.locator('#tag-note').fill(`${note}，追加内容`);
  await page.locator('#cancel-tag').click();
  await page.reload();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toHaveValue(`${note}，追加内容`);
});

test('clicking an existing highlight keeps its toolbar open and recolors one mark', async ({ page }) => {
  await setupReader(page);
  await page.locator('[data-tool="highlight"]').click();
  await selectPdfWords(page);
  await expect(page.locator('.mark-highlight')).toHaveCount(1);
  await page.locator('[data-tool="select"]').click();
  await page.locator('.pdf-word').first().click();
  await expect(page.locator('#selection-toolbar')).toHaveClass(/is-visible/);
  await page.locator('#selection-highlight-color').fill('#f795c7');
  await page.locator('[data-selection-action="highlight"]').click();
  await expect(page.locator('.mark-highlight')).toHaveCount(1);
  await expect(page.locator('.mark-highlight')).toHaveAttribute('style', /#f795c7/);
  await page.locator('#undo-mark').click();
  await expect(page.locator('.mark-highlight')).toHaveCount(1);
  await expect(page.locator('.mark-highlight')).toHaveAttribute('style', /#f6d64a/);
});

test('a mobile paper without parsed questions still provides access to saved notes and drafts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupReader(page, { questions: [] });
  await selectPdfWords(page);
  await page.locator('[data-selection-action="note"]').click();
  await page.locator('#tag-note').fill('没有题号也能恢复我的阅读笔记');
  await page.locator('#cancel-tag').click();
  await page.locator('#toggle-question-panel').click();
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#tag-note')).toHaveValue('没有题号也能恢复我的阅读笔记');
  await page.locator('#save-tag').click();
  await expect(page.locator('.tag-record-note')).toHaveText('没有题号也能恢复我的阅读笔记');
});

test('opening AI while editing a note retains its draft and gives the chat panel room', async ({ page }) => {
  const control = await setupReader(page);
  await selectPdfWords(page);
  await page.locator('[data-selection-action="note"]').click();
  await page.locator('#tag-note').fill('问 AI 前保留我的分析');
  await page.locator('#ai-floating-launcher').click();
  await expect(page.locator('#tag-editor')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#ai-question-panel')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#resume-note-draft')).toBeVisible();
  await page.locator('#close-ai-question').click();
  await page.locator('#resume-note-draft').click();
  await expect(page.locator('#tag-note')).toBeFocused();
  await expect(page.locator('#tag-note')).toHaveValue('问 AI 前保留我的分析');
  expect(control.requests).toEqual([]);
});
