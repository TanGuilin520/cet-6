const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { setupReader, PAPER_ID } = require('./reader-fixture.cjs');

const LIBRARY_KEY = 'cet:writing-template-library:v1';
const DRAFT_KEY = 'cet:writing-template-draft:v1';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=',
  'base64',
);

async function installWritingFixtures(page) {
  const control = { outsideRequests: [], apiRequests: [], pageErrors: [] };
  page.on('pageerror', (error) => control.pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      control.outsideRequests.push(url.href);
      return route.abort('blockedbyclient');
    }
    // Template authoring is local: even a regression cannot call a real model.
    if (url.pathname.startsWith('/api/')) {
      control.apiRequests.push(url.pathname);
      return route.fulfill({ status: 404, json: { error: 'No real API in writing tests' } });
    }
    if (/\.(?:png|jpg|ico)$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/png', body: PIXEL });
    }
    return route.continue();
  });
  return control;
}

async function openWriting(page) {
  const control = await installWritingFixtures(page);
  await page.goto('/writing.html');
  await page.locator('#writing-mode-full').click();
  await expect(page.locator('#template-source')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.WritingTemplates?.save)).toBe('function');
  return control;
}

async function authorTemplate(page, {
  name = '我的议论文框架',
  source = 'Nowadays, {{主题}} matters. {{论据}} In conclusion, {{主题}} deserves attention.',
  values = { 主题: 'technology', 论据: 'Practice helps people learn.' },
} = {}) {
  if (page.viewportSize().width <= 760) await page.locator('[data-writing-tab="methods"]').click();
  await page.locator('#new-template').click();
  await page.locator('#writing-mode-full').click();
  await page.locator('#template-name').fill(name);
  await page.locator('#template-source').fill(source);
  if (page.viewportSize().width <= 760) await page.locator('[data-writing-tab="preview"]').click();
  for (const [slot, value] of Object.entries(values)) {
    const input = page.locator(`#slot-fields [data-slot-name="${slot}"]`);
    await expect(input).toBeVisible();
    await input.fill(value);
  }
}

async function saveTemplate(page) {
  if (page.viewportSize().width <= 760) await page.locator('[data-writing-tab="answer"]').click();
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText(/保存/);
  return page.evaluate(() => window.WritingTemplates.list());
}

function expectClean(control) {
  expect(control.outsideRequests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
  expect(control.apiRequests).toEqual([]);
}

function writingQuestion(id = 'writing-1') {
  return {
    questionId: id, number: 1, type: 'writing', page: 1,
    stem: 'Write an essay about learning English.', confidence: 0.99,
    bbox: { x: 140, y: 170, width: 300, height: 100 },
  };
}

test('the personal writing workspace starts empty and is reachable from the platform', async ({ page }) => {
  const control = await installWritingFixtures(page);
  await page.route('**/api/exams', (route) => route.fulfill({ json: { exams: [] } }));
  await page.goto('/');
  const entry = page.locator('a[href="writing.html"]').first();
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/writing\.html(?:\?|$)/);
  await expect(page.locator('#template-source')).toHaveValue('');
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  await expect(page.locator('#new-template')).toBeVisible();
  expectClean(control);
});

test('word and sentence slots preview together and a saved template survives refresh', async ({ page }) => {
  const control = await openWriting(page);
  await page.locator('#template-name').fill('我的两类填空');
  await page.locator('#template-source').fill('Today, ');
  await page.locator('#template-source').evaluate((input) => {
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.locator('#slot-name').fill('主题词');
  await page.locator('#insert-word-slot').click();
  await page.locator('#template-source').evaluate((input) => {
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.locator('#slot-name').fill('支持句');
  await page.locator('#insert-sentence-slot').click();
  await page.locator('#slot-fields input[data-slot-name="主题词"]').fill('education');
  await page.locator('#slot-fields textarea[data-slot-name="支持句"]').fill('It gives everyone a chance.');
  await expect(page.locator('#template-preview')).toContainText('education');
  await expect(page.locator('#template-preview')).toContainText('It gives everyone a chance.');
  const saved = await saveTemplate(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].slots.map((slot) => slot.type)).toEqual(['word', 'sentence']);
  await page.reload();
  await expect(page.locator('#template-name')).toHaveValue('我的两类填空');
  await expect(page.locator('#slot-fields [data-slot-name="主题词"]')).toHaveValue('education');
  await expect(page.locator('#slot-fields [data-slot-name="支持句"]')).toHaveValue('It gives everyone a chance.');
  expectClean(control);
});

test('a manually typed slot can switch between sentence and word without losing its value', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page, {
    name: '可以切换类型的填空', source: 'Today, {{主题词}} matters.', values: { 主题词: 'lifelong learning' },
  });
  const type = page.locator('select[data-slot-type="主题词"]');
  await expect(page.locator('#slot-fields textarea[data-slot-name="主题词"]')).toHaveValue('lifelong learning');
  await expect(type).toHaveValue('sentence');
  await type.selectOption('word');
  await expect(page.locator('#slot-fields input[data-slot-name="主题词"]')).toHaveValue('lifelong learning');
  await expect(page.locator('#slot-fields textarea[data-slot-name="主题词"]')).toHaveCount(0);
  await expect(page.locator('#template-preview')).toHaveText('Today, lifelong learning matters.');
  const [saved] = await saveTemplate(page);
  expect(saved.slots[0]).toMatchObject({ name: '主题词', value: 'lifelong learning', type: 'word' });
  await page.reload();
  await expect(type).toHaveValue('word');
  await expect(page.locator('#slot-fields input[data-slot-name="主题词"]')).toHaveValue('lifelong learning');
  await type.selectOption('sentence');
  const sentence = page.locator('#slot-fields textarea[data-slot-name="主题词"]');
  await expect(sentence).toHaveValue('lifelong learning');
  await expect(page.locator('#slot-fields input[data-slot-name="主题词"]')).toHaveCount(0);
  await sentence.fill('lifelong learning\nand daily practice');
  await saveTemplate(page);
  await page.reload();
  await expect(type).toHaveValue('sentence');
  await expect(sentence).toHaveValue('lifelong learning\nand daily practice');
  await expect(page.locator('#template-preview')).toHaveText('Today, lifelong learning\nand daily practice matters.');
  expectClean(control);
});

test('repeated placeholders share one field and unfilled positions remain identifiable', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page, { values: {} });
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(2);
  await expect(page.locator('#template-preview')).toContainText('主题');
  await page.locator('#slot-fields [data-slot-name="主题"]').fill('education');
  await page.locator('#slot-fields [data-slot-name="论据"]').fill('Schools open new opportunities.');
  await expect(page.locator('#template-preview')).toHaveText(
    'Nowadays, education matters. Schools open new opportunities. In conclusion, education deserves attention.',
  );
  expectClean(control);
});

test('selected text becomes an editable sentence slot without losing the original phrase', async ({ page }) => {
  const control = await openWriting(page);
  await page.locator('#template-name').fill('改造成填空');
  await page.locator('#template-source').fill('Nowadays, education matters.');
  await page.locator('#template-source').evaluate((input) => {
    input.focus(); input.setSelectionRange(10, 19);
  });
  await page.locator('#slot-name').fill('主题表达');
  await page.locator('#selection-to-slot').click();
  await expect(page.locator('#template-source')).toHaveValue('Nowadays, {{主题表达}} matters.');
  await expect(page.locator('#slot-fields [data-slot-name="主题表达"]')).toHaveValue('education');
  await page.locator('#slot-fields [data-slot-name="主题表达"]').fill('lifelong learning');
  await expect(page.locator('#template-preview')).toHaveText('Nowadays, lifelong learning matters.');
  expectClean(control);
});

test('an unsaved draft and its slot values survive refresh without becoming a saved template', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page, { name: '还在修改的作文框架' });
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBeTruthy();
  await page.reload();
  await expect(page.locator('#template-name')).toHaveValue('还在修改的作文框架');
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('technology');
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  expectClean(control);
});

test('independent drafts remain accessible when another draft is saved', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page, { name: '观点型草稿', values: { 主题: 'education', 论据: 'Learning expands our choices.' } });
  await authorTemplate(page, { name: '现象型草稿', values: { 主题: 'technology', 论据: 'Digital tools change our lives.' } });
  await expect(page.locator('#draft-list [data-draft-key]')).toHaveCount(2);
  await page.locator('#draft-list').getByRole('button', { name: /观点型草稿/ }).click();
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('education');
  await saveTemplate(page);
  await expect(page.locator('#draft-list [data-draft-key]')).toHaveCount(1);
  await page.locator('#draft-list').getByRole('button', { name: /现象型草稿/ }).click();
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('technology');
  await page.reload();
  await expect(page.locator('#template-name')).toHaveValue('现象型草稿');
  await expect(page.locator('#slot-fields [data-slot-name="论据"]')).toHaveValue('Digital tools change our lives.');
  expect((await page.evaluate(() => window.WritingTemplates.list())).map((template) => template.name)).toEqual(['观点型草稿']);
  expectClean(control);
});

test('UTF-8 Markdown import remains a draft and a static template explains how to add slots', async ({ page }) => {
  const control = await openWriting(page);
  await page.locator('#template-file').setInputFiles({
    name: '我的开头.md', mimeType: 'text/markdown',
    buffer: Buffer.from('Nowadays, {{主题}} has become important.\n{{我的例子}}', 'utf8'),
  });
  await expect(page.locator('#template-source')).toHaveValue('Nowadays, {{主题}} has become important.\n{{我的例子}}');
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(2);
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  await page.locator('#template-file').setInputFiles({
    name: '固定结尾.txt', mimeType: 'text/plain', buffer: Buffer.from('We should take action together.', 'utf8'),
  });
  await expect(page.locator('#template-source')).toHaveValue('We should take action together.');
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(0);
  await expect(page.locator('#slot-help')).toContainText(/没有|无|选中/);
  await page.locator('#template-name').fill('固定结尾');
  expect(await saveTemplate(page)).toHaveLength(1);
  expectClean(control);
});

test('invalid UTF-8 and binary imports cannot replace the current draft', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page);
  const before = await page.locator('#template-source').inputValue();
  for (const buffer of [Buffer.from([0xc3, 0x28]), Buffer.from('hidden\0binary')]) {
    await page.locator('#template-file').setInputFiles({ name: '坏文件.txt', mimeType: 'text/plain', buffer });
    await expect(page.locator('#writing-status')).toContainText(/UTF-8|纯文本|二进制/);
    await expect(page.locator('#template-source')).toHaveValue(before);
    await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('technology');
  }
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  expectClean(control);
});

test('a failed library save preserves the previous version and the editable draft', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page);
  const [original] = await saveTemplate(page);
  await page.locator('#template-source').fill('My revised argument is {{主题}}.');
  await page.evaluate((key) => {
    window.__writingOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === key) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return window.__writingOriginalSetItem.call(this, storageKey, value);
    };
  }, LIBRARY_KEY);
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText(/失败|不足|无法|不能/);
  await expect(page.locator('#template-source')).toHaveValue('My revised argument is {{主题}}.');
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).source, original.id)).toBe(original.source);
  await page.evaluate(() => { Storage.prototype.setItem = window.__writingOriginalSetItem; });
  await saveTemplate(page);
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).source, original.id)).toBe('My revised argument is {{主题}}.');
  await page.reload();
  await expect(page.locator('#template-source')).toHaveValue('My revised argument is {{主题}}.');
  expectClean(control);
});

test('preview treats template and slot HTML as text rather than executable markup', async ({ page }) => {
  const control = await openWriting(page);
  const attack = '<img src=x onerror="window.__writingXss = 1"><script>window.__writingXss = 2</script>';
  await authorTemplate(page, { source: `Literal <b>not bold</b>: {{例子}}`, values: { 例子: attack } });
  await expect(page.locator('#template-preview')).toContainText(attack);
  await expect(page.locator('#template-preview img, #template-preview script, #template-preview b')).toHaveCount(0);
  expect(await page.evaluate(() => window.__writingXss)).toBeUndefined();
  await saveTemplate(page);
  await page.reload();
  await expect(page.locator('#template-preview')).toContainText(attack);
  expectClean(control);
});

test('text export matches the current preview and deletion requires confirmation', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page);
  const [saved] = await saveTemplate(page);
  const downloadPending = page.waitForEvent('download');
  await page.locator('#export-template').click();
  const download = await downloadPending;
  const content = await fs.readFile(await download.path(), 'utf8');
  expect(content).toBe('Nowadays, technology matters. Practice helps people learn. In conclusion, technology deserves attention.');
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).source, saved.id)).toContain('{{主题}}');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#delete-template').click();
  expect(await page.evaluate((id) => Boolean(window.WritingTemplates.get(id)), saved.id)).toBe(true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#delete-template').click();
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  await page.reload();
  expect(await page.evaluate(() => window.WritingTemplates.list())).toEqual([]);
  expectClean(control);
});

test('original template export preserves placeholders for later import', async ({ page }) => {
  const control = await openWriting(page);
  await authorTemplate(page);
  const [saved] = await saveTemplate(page);
  const pending = page.waitForEvent('download');
  await page.locator('#export-source').click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const exported = await fs.readFile(await download.path(), 'utf8');
  expect(exported).toBe(saved.source);
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).slots[0].value, saved.id)).toBe('technology');
  await page.locator('#template-file').setInputFiles({
    name: download.suggestedFilename(), mimeType: 'text/markdown', buffer: Buffer.from(exported, 'utf8'),
  });
  await expect(page.locator('#template-source')).toHaveValue(saved.source);
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(2);
  await expect(page.locator('#slot-fields [data-slot-name="主题"]')).toHaveValue('');
  await expect(page.locator('#template-preview')).toContainText('{{主题}}');
  expect(await page.evaluate(() => window.WritingTemplates.list())).toHaveLength(1);
  expectClean(control);
});

test('mobile authoring keeps the workspace in bounds and supports sentence entry and saving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await openWriting(page);
  await authorTemplate(page, { name: '手机上的个人模板', values: { 主题: 'learning', 论据: 'Small daily steps help.\nThey build confidence.' } });
  await expect(page.locator('#template-preview')).toContainText('They build confidence.');
  await saveTemplate(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.reload();
  await expect(page.locator('#template-name')).toHaveValue('手机上的个人模板');
  await expect(page.locator('#slot-fields [data-slot-name="论据"]')).toHaveValue('Small daily steps help.\nThey build confidence.');
  expectClean(control);
});

test('a library template is copied per paper and only explicit apply changes the essay', async ({ page }) => {
  const authorControl = await openWriting(page);
  await authorTemplate(page);
  const [saved] = await saveTemplate(page);
  const readerControl = await setupReader(page, { questions: [writingQuestion()] });
  await expect(page.locator('#open-writing-library')).toBeVisible();
  await expect(page.locator('#open-writing-library')).toHaveAttribute('href', new RegExp(`^writing\\.html\\?paper=${PAPER_ID}(?:&|$)`));
  const essay = page.locator('[data-long-answer="writing-1"]');
  await expect(essay).toHaveValue('');
  await page.locator('[data-writing-library-select]').selectOption(saved.id);
  await page.locator('[data-use-writing-library-template]').click();
  await expect(essay).toHaveValue('');
  await expect(page.locator('[data-writing-template-slot]').first()).toHaveValue('technology');
  await page.locator('[data-writing-template-slot]').first().fill('education');
  await expect(essay).toHaveValue('');
  await page.locator('[data-apply-writing-template]').click();
  await expect(essay).toHaveValue('Nowadays, education matters. Practice helps people learn. In conclusion, education deserves attention.');
  expect(await page.evaluate((id) => window.WritingTemplates.get(id).slots[0].value, saved.id)).toBe('technology');
  await page.reload();
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('Nowadays, education matters. Practice helps people learn. In conclusion, education deserves attention.');

  const secondPaper = `${PAPER_ID}-second`;
  await page.route(`**/api/exams/${secondPaper}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/manifest')) return route.fulfill({ json: {
      title: 'Another synthetic writing paper', pageCount: 1,
      pages: [{ number: 1, width: 595, height: 842, image: 'page.png', words: [] }],
    } });
    if (pathname.endsWith('/questions')) return route.fulfill({ json: { revision: 1, questions: [writingQuestion()] } });
    if (pathname.endsWith('/answers')) return route.fulfill({ json: { revision: 1, answers: [] } });
    if (pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: PIXEL });
    return route.fulfill({ status: 404, json: { error: 'No model fixture for another paper' } });
  });
  await page.goto(`/reader.html?paper=${secondPaper}`);
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('');
  await page.locator('[data-writing-library-select]').selectOption(saved.id);
  await page.locator('[data-use-writing-library-template]').click();
  await expect(page.locator('[data-writing-template-slot]').first()).toHaveValue('technology');
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('');
  expect(authorControl.outsideRequests).toEqual([]);
  expect(authorControl.pageErrors).toEqual([]);
  expect(readerControl.outsideRequests).toEqual([]);
  expect(readerControl.pageErrors).toEqual([]);
  expect(readerControl.requests).toEqual([]);
});

test('applying a template cannot overwrite an existing essay when confirmation is declined', async ({ page }) => {
  await openWriting(page);
  await authorTemplate(page);
  const [saved] = await saveTemplate(page);
  const control = await setupReader(page, { questions: [writingQuestion()] });
  const essay = page.locator('[data-long-answer="writing-1"]');
  await essay.fill('This paragraph was written by me.');
  await page.locator('[data-writing-library-select]').selectOption(saved.id);
  await page.locator('[data-use-writing-library-template]').click();
  await expect(essay).toHaveValue('This paragraph was written by me.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-apply-writing-template]').click();
  await expect(essay).toHaveValue('This paragraph was written by me.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-apply-writing-template]').click();
  await expect(essay).toHaveValue('Nowadays, technology matters. Practice helps people learn. In conclusion, technology deserves attention.');
  expect(control.requests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('a static paragraph template remains available in the reader after refresh', async ({ page }) => {
  await openWriting(page);
  const paragraph = 'In conclusion, we should learn continuously and use our knowledge responsibly.';
  await authorTemplate(page, { name: '固定结尾段', source: paragraph, values: {} });
  const [saved] = await saveTemplate(page);
  const control = await setupReader(page, { questions: [writingQuestion()] });
  await page.locator('[data-writing-library-select]').selectOption(saved.id);
  await page.locator('[data-use-writing-library-template]').click();
  await expect(page.locator('[data-writing-template-preview]')).toHaveText(paragraph);
  await expect(page.locator('[data-writing-template-slot]')).toHaveCount(0);
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('');
  await page.reload();
  await expect(page.locator('[data-writing-template-preview]')).toHaveText(paragraph);
  await page.locator('[data-apply-writing-template]').click();
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue(paragraph);
  expect(control.requests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('a long slot name repeated more than forty times compiles in both library and reader', async ({ page }) => {
  await openWriting(page);
  const name = '主题表达'.repeat(20); // Exactly the documented 80-character boundary.
  const source = `{{${name}}}. `.repeat(45);
  await authorTemplate(page, { name: '长名称与重复填空', source, values: { [name]: 'Practice matters' } });
  await expect(page.locator('#slot-fields [data-slot-name]')).toHaveCount(1);
  await expect(page.locator('#template-preview')).toHaveText('Practice matters. '.repeat(45));
  const [saved] = await saveTemplate(page);
  const control = await setupReader(page, { questions: [writingQuestion()] });
  await page.locator('[data-writing-library-select]').selectOption(saved.id);
  await page.locator('[data-use-writing-library-template]').click();
  await expect(page.locator('[data-writing-template-slot]')).toHaveCount(1);
  await page.locator('[data-writing-template-slot]').fill('Lifelong learning matters');
  await page.locator('[data-apply-writing-template]').click();
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('Lifelong learning matters. '.repeat(45));
  await page.reload();
  await expect(page.locator('[data-writing-template-slot]')).toHaveValue('Lifelong learning matters');
  await expect(page.locator('[data-long-answer="writing-1"]')).toHaveValue('Lifelong learning matters. '.repeat(45));
  expect(control.requests).toEqual([]);
  expect(control.pageErrors).toEqual([]);
});

test('library limits and corrupt storage reject writes without losing the stored content', async ({ page }) => {
  const control = await openWriting(page);
  const validation = await page.evaluate((key) => {
    const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
    const invalid = [
      '{{ }}', '{{a\nb}}', 'not paired {{name',
      Array.from({ length: 41 }, (_, index) => `{{slot${index}}}`).join(' '),
      'x'.repeat(12001),
    ].map((source) => rejects(() => window.WritingTemplates.parse(source)));
    const excessiveValue = rejects(() => window.WritingTemplates.save({
      name: 'too long', source: '{{slot}}', slots: [{ name: 'slot', value: 'x'.repeat(1001), type: 'sentence' }],
    }));
    for (let index = 0; index < 30; index += 1) {
      window.WritingTemplates.save({ name: `template ${index}`, source: 'A fixed paragraph.' });
    }
    const before = localStorage.getItem(key);
    const excessiveCount = rejects(() => window.WritingTemplates.save({ name: 'template 31', source: 'Another paragraph.' }));
    const unchangedAfterLimit = localStorage.getItem(key) === before;
    const corrupt = '{malformed but recoverable user data';
    localStorage.setItem(key, corrupt);
    const corruptedSave = rejects(() => window.WritingTemplates.save({ name: 'cannot overwrite', source: 'Another paragraph.' }));
    const corruptedDelete = rejects(() => window.WritingTemplates.remove('missing-template'));
    return { invalid, excessiveValue, excessiveCount, unchangedAfterLimit, corruptedSave, corruptedDelete, unchangedCorrupt: localStorage.getItem(key) === corrupt };
  }, LIBRARY_KEY);
  expect(validation).toEqual({
    invalid: [true, true, true, true, true], excessiveValue: true, excessiveCount: true,
    unchangedAfterLimit: true, corruptedSave: true, corruptedDelete: true, unchangedCorrupt: true,
  });
  await page.locator('#template-name').fill('保留当前输入');
  await page.locator('#template-source').fill('I must not lose this editable paragraph.');
  await page.locator('#save-template').click();
  await expect(page.locator('#writing-status')).toContainText(/无法读取|备份/);
  await expect(page.locator('#template-source')).toHaveValue('I must not lose this editable paragraph.');
  expectClean(control);
});
