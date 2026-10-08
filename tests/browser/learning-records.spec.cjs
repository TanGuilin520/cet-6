const { test, expect } = require('@playwright/test');

const PAPER_A = 'learning-fixture-a';
const PAPER_B = 'learning-fixture-b';
const NOTES = 'cet:translation-notes:v1';
const EXPRESSIONS = 'cet:expression-library:v1';
const EXAM = `exam-viewer:${PAPER_A}:v1`;
const TIME = '2026-10-08T00:00:00Z';

function note(paper = PAPER_A, original = '随着城市的发展') {
  return { contextKey: `${paper}:question:translation-1`, paper, question: 'translation-1', page: 2,
    original, firstDraft: 'With the city developing', revised: 'With the development of the city',
    reason: 'with 后接名词结构', method: '随着：with / as', freeNote: '我的复盘记录', updatedAt: TIME,
    methodRefs: [{ source: 'github', id: 'cet6-translation-section-01', title: '1 随着' }] };
}

function expression(id = 'fixture-expression', text = 'In conclusion, education matters.') {
  return { id, text, category: 'conclusion', tags: ['education'], example: 'My own example.',
    source: '这道作文的结尾', context: { paper: PAPER_A, question: 'writing-1', page: 1, module: 'writing' }, updatedAt: TIME };
}

function fixture() {
  return {
    [NOTES]: [note()],
    'cet:writing-answers:v1': { version: 1, entries: [{ contextKey: `${PAPER_B}:writing-1`, paper: PAPER_B,
      question: 'writing-1', page: 1, name: '教育主题作文', source: 'Opening paragraph.\n\nBody paragraph.\n\nConclusion.',
      answer: 'Opening paragraph.\n\nBody paragraph.\n\nConclusion.', slots: [], updatedAt: TIME }] },
    [EXAM]: { answers: { q1: 'B' }, annotations: [{ id: 'fixture-tag', type: 'tag', page: 2,
      rects: [{ x: 20, y: 50, width: 100, height: 14 }], wordIds: [1], quote: 'The original sentence.',
      label: '语法', note: '注意这里的从句。', tone: 'blue', createdAt: 1720000000000 }], zoom: 1.2 },
    [EXPRESSIONS]: { version: 1, entries: [expression()] },
    'unrelated:secret': { value: 'must never be backed up' },
  };
}

function backup(records) {
  return { format: 'cet-learning-backup', version: 1, createdAt: TIME,
    records: Object.entries(records).map(([key, value]) => ({ key, value })) };
}

async function openHub(page, records = fixture()) {
  const control = { external: [], api: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      control.external.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) {
      control.api.push(url.pathname); return route.fulfill({ status: 404, json: { error: 'No APIs in learning hub tests' } });
    }
    return route.continue();
  });
  await page.addInitScript((values) => {
    Object.entries(values).forEach(([key, value]) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    });
  }, records);
  await page.goto('/learning.html');
  await expect.poll(() => page.evaluate(() => typeof window.LearningStore?.parseBackup)).toBe('function');
  return control;
}

function clean(control) {
  expect(control.external).toEqual([]); expect(control.api).toEqual([]); expect(control.errors).toEqual([]);
}

async function downloadText(download) {
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('hub aggregates four record types and searches across papers, methods and tags', async ({ page }) => {
  const control = await openHub(page);
  await expect(page.locator('[data-learning-record]')).toHaveCount(4);
  await page.locator('#learning-search').fill('随着');
  await expect(page.locator('[data-learning-record]')).toHaveCount(1);
  await expect(page.locator('[data-learning-record]')).toContainText('with 后接名词结构');
  await page.locator('#learning-search').fill('');
  await page.locator('#learning-type').selectOption('writing');
  await expect(page.locator('[data-learning-record]')).toHaveCount(1);
  await expect(page.locator('[data-learning-record]')).toContainText('教育主题作文');
  await page.locator('#learning-type').selectOption('');
  await page.locator('#learning-paper').selectOption(PAPER_A);
  await expect(page.locator('[data-learning-record]')).toHaveCount(3);
  clean(control);
});

test('review mode hides revised content and saves new attempt without changing the original note', async ({ page }) => {
  const control = await openHub(page);
  await page.locator('#learning-type').selectOption('translation');
  await page.locator('#learning-review-mode').check();
  const card = page.locator('[data-learning-record]');
  await expect(card.locator('[data-comparison]')).toBeHidden();
  await expect(card).toContainText('随着城市的发展');
  await card.locator('[data-review-attempt]').fill('As the city develops, ...');
  await card.getByRole('button', { name: '保存这次重练' }).click();
  const saved = await page.evaluate((key) => ({ note: JSON.parse(localStorage.getItem(key)), review: JSON.parse(localStorage.getItem('cet:learning-review:v1')) }), NOTES);
  expect(saved.note).toEqual([note()]);
  expect(Object.values(saved.review.entries)).toEqual(['As the city develops, ...']);
  await card.locator('[data-reveal-comparison]').click();
  await expect(card.locator('[data-comparison]')).toBeVisible();
  await expect(card.locator('[data-comparison]')).toContainText('With the development of the city');
  clean(control);
});

test('source links preserve the exact paper, question, page and reader note identity', async ({ page }) => {
  const control = await openHub(page);
  const translation = page.locator(`[data-learning-record="translation:${PAPER_A}:question:translation-1"]`);
  const source = new URL(await translation.getByRole('link', { name: '回到试卷位置 →' }).getAttribute('href'), 'http://127.0.0.1');
  expect(source.pathname).toBe('/reader.html'); expect(source.searchParams.get('paper')).toBe(PAPER_A);
  expect(source.searchParams.get('question')).toBe('translation-1'); expect(source.searchParams.get('page')).toBe('2');
  const reader = page.locator(`[data-learning-record="reader:${PAPER_A}:fixture-tag"]`);
  const tag = new URL(await reader.getByRole('link', { name: '回到试卷位置 →' }).getAttribute('href'), 'http://127.0.0.1');
  expect(tag.searchParams.get('note')).toBe('fixture-tag'); expect(tag.searchParams.get('page')).toBe('2');
  clean(control);
});

test('expression insertion and hub rendering keep HTML inert and honor the active caret', async ({ page }) => {
  const attack = '<img src=x onerror="window.learningPwned=1">';
  const records = fixture(); records[EXPRESSIONS].entries = [expression('attack-expression', attack)];
  const control = await openHub(page, records);
  await expect(page.locator('#learning-records')).toContainText(attack);
  expect(await page.locator('#learning-records img').count()).toBe(0);
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'fixture-expression-host'; document.body.append(host);
    const target = document.createElement('textarea'); target.id = 'fixture-expression-target'; target.maxLength = 3000;
    target.value = 'Before  after'; document.body.append(target); target.setSelectionRange(7, 7);
    window.LearningStore.mountExpressions({ container: host, getTarget: () => target, context: { paper: 'learning-fixture-a', module: 'writing' } });
    host.querySelector('details').open = true;
  });
  await page.locator('[data-insert-expression="attack-expression"]').click();
  await expect(page.locator('#fixture-expression-target')).toHaveValue(`Before ${attack} after`);
  expect(await page.evaluate(() => window.learningPwned)).toBeUndefined();
  clean(control);
});

test('backup rejects unsupported keys, versions, unsafe trees and unknown envelope fields without writes', async ({ page }) => {
  const control = await openHub(page);
  const good = backup({ [NOTES]: [note(PAPER_B)] });
  const variants = [
    { ...good, version: 99 },
    backup({ 'unrelated:secret': { value: 'reject' } }),
    { ...good, unexpected: true },
    { ...good, records: [{ ...good.records[0], unexpected: true }] },
    { ...good, records: [{ key: NOTES, value: [{ ...note(), constructor: { polluted: true } }] }] },
    JSON.stringify(good).slice(0, -1) + ',"__proto__":{"polluted":true}}',
  ];
  const result = await page.evaluate((values) => {
    const before = JSON.stringify({ ...localStorage });
    const rejected = values.map((value) => {
      try { window.LearningStore.restoreBackup(typeof value === 'string' ? JSON.parse(value) : value); return false; }
      catch (_error) { return true; }
    });
    return { rejected, unchanged: before === JSON.stringify({ ...localStorage }), polluted: {}.polluted };
  }, variants);
  expect(result.rejected).toEqual(variants.map(() => true));
  expect(result.unchanged).toBe(true); expect(result.polluted).toBeUndefined();
  clean(control);
});

test('restore merges same-partition notes and exam answers while preserving other paper data', async ({ page }) => {
  const control = await openHub(page);
  const incoming = backup({ [NOTES]: [note(PAPER_B, '另一份试卷的原文')],
    [EXAM]: { answers: { q2: 'C' }, annotations: [], zoom: 0.9 },
    [EXPRESSIONS]: { version: 1, entries: [expression('another-expression', 'Another expression.')] } });
  const result = await page.evaluate((value) => {
    const count = window.LearningStore.restoreBackup(value);
    return { count, notes: JSON.parse(localStorage.getItem('cet:translation-notes:v1')),
      exam: JSON.parse(localStorage.getItem('exam-viewer:learning-fixture-a:v1')),
      expressions: window.LearningStore.expressions(), untouched: localStorage.getItem('unrelated:secret') };
  }, incoming);
  expect(result.count).toBe(3); expect(result.notes).toHaveLength(2);
  expect(result.notes.map((item) => item.paper).sort()).toEqual([PAPER_A, PAPER_B]);
  expect(result.exam.answers).toEqual({ q1: 'B', q2: 'C' }); expect(result.exam.annotations).toHaveLength(1);
  expect(result.exam.submitted).toBe(false); expect(result.exam.grade).toBeNull();
  expect(result.expressions).toHaveLength(2); expect(JSON.parse(result.untouched).value).toBe('must never be backed up');
  clean(control);
});

test('a later quota error rolls back earlier backup writes', async ({ page }) => {
  const control = await openHub(page);
  const result = await page.evaluate((value) => {
    const keys = value.records.map((entry) => entry.key);
    const before = keys.map((key) => localStorage.getItem(key));
    const original = Storage.prototype.setItem; let writes = 0; let message = '';
    Storage.prototype.setItem = function (key, text) {
      if (++writes === 2) throw new DOMException('Simulated quota', 'QuotaExceededError');
      return original.call(this, key, text);
    };
    try { window.LearningStore.restoreBackup(value); }
    catch (error) { message = error.message; }
    finally { Storage.prototype.setItem = original; }
    return { message, before, after: keys.map((key) => localStorage.getItem(key)) };
  }, backup({ [NOTES]: [note(PAPER_B)], [EXPRESSIONS]: { version: 1, entries: [expression('quota-expression')] } }));
  expect(result.message).toContain('已撤回'); expect(result.after).toEqual(result.before);
  clean(control);
});

test('damaged local data remains untouched and is recoverable as raw JSON backup text', async ({ page }) => {
  const control = await openHub(page, { [NOTES]: '{broken-json', [EXPRESSIONS]: '{broken-expression-json' });
  await expect(page.locator('#learning-status')).toContainText('无法读取');
  const result = await page.evaluate((key) => {
    const before = localStorage.getItem(key); const exported = window.LearningStore.backup();
    let rejected = false;
    try { window.LearningStore.restoreBackup({ format: 'cet-learning-backup', version: 1, records: [{ key, value: [] }] }); }
    catch (_error) { rejected = true; }
    let expressionRejected = false;
    try { window.LearningStore.saveExpression({ text: 'Keep me', category: 'other', tags: [], context: {} }); }
    catch (_error) { expressionRejected = true; }
    return { before, after: localStorage.getItem(key), exported, rejected, expressionRejected };
  }, NOTES);
  expect(result.rejected).toBe(true); expect(result.expressionRejected).toBe(true); expect(result.after).toBe(result.before);
  expect(result.exported.records.find((entry) => entry.key === NOTES)).toMatchObject({ raw: '{broken-json', unreadable: true });
  clean(control);
});

test('invalid reader note drafts cannot merge under an undefined identity', async ({ page }) => {
  const control = await openHub(page);
  const rejected = await page.evaluate((value) => {
    try { window.LearningStore.parseBackup(JSON.stringify(value)); return false; } catch (_error) { return true; }
  }, backup({ [`${EXAM}:note-drafts`]: [{ note: 'No key, rects or page' }, { note: 'Would overwrite the first note' }] }));
  expect(rejected).toBe(true);
  clean(control);
});

test('restored translation note schemas match the actual workspace reader guards', async ({ page }) => {
  const control = await openHub(page);
  const noPage = note(); delete noPage.page;
  const emptyRef = note(); emptyRef.methodRefs[0].id = '';
  const duplicateRef = note(); duplicateRef.methodRefs.push({ ...duplicateRef.methodRefs[0] });
  const noQuestion = note(); delete noQuestion.question;
  const invalid = [noPage, emptyRef, duplicateRef, noQuestion];
  const result = await page.evaluate((items) => items.map((item) => {
    try { window.LearningStore.parseBackup(JSON.stringify({ format: 'cet-learning-backup', version: 1,
      records: [{ key: 'cet:translation-notes:v1', value: [item] }] })); return false; }
    catch (_error) { return true; }
  }), invalid);
  expect(result).toEqual(invalid.map(() => true));
  clean(control);
});

test('out-of-range reader timestamps do not crash the entire learning hub', async ({ page }) => {
  const records = fixture(); records[EXAM].annotations[0].createdAt = 1e30;
  const control = await openHub(page, records);
  // Invalid timestamps are rejected as a damaged partition. Other learning
  // records must remain usable and the original raw partition stays intact.
  await expect(page.locator('[data-learning-record]')).toHaveCount(3);
  await expect(page.locator('#learning-status')).toContainText('无法读取');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).annotations[0].createdAt, EXAM)).toBe(1e30);
  clean(control);
});

test('invalid reader quote objects are isolated without replacing original storage', async ({ page }) => {
  const records = fixture(); records[EXAM].annotations[0].quote = { toString: 1 };
  const control = await openHub(page, records);
  await expect(page.locator('[data-learning-record]')).toHaveCount(3);
  await expect(page.locator('#learning-status')).toContainText('无法读取');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).annotations[0].quote, EXAM)).toEqual({ toString: 1 });
  clean(control);
});

test('Markdown export follows current filters and JSON excludes unrelated storage keys', async ({ page }) => {
  const control = await openHub(page);
  await page.locator('#learning-type').selectOption('translation');
  await page.locator('#learning-review-mode').check();
  await expect(page.locator('[data-comparison]')).toBeHidden();
  const markdownDownload = page.waitForEvent('download');
  await page.locator('#learning-export-md').click();
  const markdownFile = await markdownDownload;
  expect(markdownFile.suggestedFilename()).toBe('cet-learning-records.md');
  const markdown = await downloadText(markdownFile);
  expect(markdown).toContain('With the development of the city');
  expect(markdown).not.toContain('Opening paragraph.');
  const jsonDownload = page.waitForEvent('download');
  await page.locator('#learning-export-json').click();
  const json = JSON.parse(await downloadText(await jsonDownload));
  expect(json.format).toBe('cet-learning-backup'); expect(json.version).toBe(1);
  expect(json.records).toHaveLength(4);
  expect(json.records.map((entry) => entry.key)).not.toContain('unrelated:secret');
  clean(control);
});

test('file restore requires a preview and cancellation never modifies storage', async ({ page }) => {
  const control = await openHub(page);
  const before = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  await page.locator('#learning-backup-file').setInputFiles({ name: 'learning-backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup({ [NOTES]: [note(PAPER_B)] }))) });
  await expect(page.locator('#learning-import-preview')).toBeVisible();
  await expect(page.locator('#learning-import-summary')).toContainText('尚未写入');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(before);
  await page.locator('#learning-cancel-import').click();
  await expect(page.locator('#learning-import-preview')).toBeHidden();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(before);
  clean(control);
});

test('mobile hub remains within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await openHub(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.locator('#learning-review-mode').check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  clean(control);
});
