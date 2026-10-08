const EXAM_ID_PATTERN = /^exam-[0-9]{8}-[0-9a-f]{12}$/;
const covers = ['ocean', 'coral', 'forest', 'violet', 'slate', 'gold'];

function unifiedReaderUrl(paperId) {
  return `reader.html?paper=${encodeURIComponent(String(paperId))}&cachefix=20261007-platform-1`;
}

const papers = [];

const state = {
  filter: 'all',
  query: '',
  showOlder: false,
  favorites: loadFavorites(),
  favoriteOnly: false,
  catalogStatus: 'loading',
  pendingCount: 0,
};

const groupNode = document.querySelector('#paper-groups');
const emptyNode = document.querySelector('#empty-state');
const loadMoreButton = document.querySelector('#load-more');
const searchInput = document.querySelector('#paper-search');
const favoriteCount = document.querySelector('#favorite-count');
const paperTotal = document.querySelector('#paper-total');
const dialog = document.querySelector('#paper-dialog');
const dialogContent = document.querySelector('#dialog-content');
const backdrop = document.querySelector('#dialog-backdrop');
const toast = document.querySelector('#toast');
const catalogError = document.querySelector('#catalog-error');
const retryExams = document.querySelector('#retry-exams');
let toastTimer;

updatePaperTotal();

function esc(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function loadFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem('cet4-favorites') || '[]');
    return new Set(Array.isArray(stored) ? stored.map(String).slice(0, 500) : []);
  } catch {
    return new Set();
  }
}

function updatePaperTotal() {
  paperTotal.textContent = String(papers.length);
  if (paperTotal.nextElementSibling) paperTotal.nextElementSibling.textContent = '套可用试卷';
}

function normalizedDateParts(item) {
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  const titleDate = title.match(/\b((?:19|20)\d{2})\s*(?:年|[-./])?\s*(0?[1-9]|1[0-2])(?:\s*月)?/);
  let year = titleDate?.[1] || '';
  let monthNumber = Number(titleDate?.[2]);
  if (!year || !monthNumber) {
    const created = new Date(String(item?.createdAt || ''));
    if (!Number.isNaN(created.getTime())) {
      year = String(created.getFullYear());
      monthNumber = created.getMonth() + 1;
    }
  }
  if (!/^(?:19|20)\d{2}$/.test(year)) year = String(new Date().getFullYear());
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) monthNumber = 1;
  const setMatch = title.match(/(?:第\s*([1-9][0-9]?)\s*套|\bset\s*0?([1-9][0-9]?)\b)/i);
  const setNumber = Math.min(99, Number(setMatch?.[1] || setMatch?.[2]) || 1);
  return {
    year,
    month: String(monthNumber).padStart(2, '0'),
    period: monthNumber <= 6 ? '上半年' : '下半年',
    set: String(setNumber).padStart(2, '0'),
  };
}

function coverForExam(examId) {
  const score = [...examId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return covers[score % covers.length];
}

function normalizeApiPaper(item) {
  if (!item || typeof item !== 'object' || item.status !== 'ready') return null;
  const examId = String(item.examId || '').trim();
  if (!EXAM_ID_PATTERN.test(examId)) return null;
  const date = normalizedDateParts(item);
  const title = String(item.title || '未命名英语试卷').replace(/\s+/g, ' ').trim().slice(0, 160) || '未命名英语试卷';
  const directQuestionCount = item.questionCount === null || item.questionCount === '' ? NaN : Number(item.questionCount);
  const legacyQuestionCount = Number(item.result?.reviewCounts?.questions?.total);
  const total = Number.isInteger(directQuestionCount) && directQuestionCount >= 0
    ? directQuestionCount
    : legacyQuestionCount;
  const directAnswerCount = item.answerCount === null || item.answerCount === '' ? NaN : Number(item.answerCount);
  const legacyAnswerCount = Number(item.result?.reviewCounts?.answers?.total);
  const answerCount = Number.isInteger(directAnswerCount) && directAnswerCount >= 0
    ? directAnswerCount
    : legacyAnswerCount;
  const hasQuestions = Number.isInteger(total) && total > 0;
  const hasAudio = item.hasAudio === true;
  const hasAnswer = item.hasAnswer === true || (Number.isInteger(answerCount) && answerCount > 0);
  return {
    id: examId,
    runtimePaperId: examId,
    ...date,
    title,
    tags: ['用户上传', hasAudio ? '含听力' : hasAnswer ? '含答案' : '原卷阅读'],
    difficulty: hasAnswer ? '含答案' : '已生成',
    cover: coverForExam(examId),
    questions: hasQuestions ? `${total} 题` : '原卷阅读',
    questionCount: hasQuestions ? total : 0,
    done: 0,
    hasAudio,
    hasAnswer,
    hasQuestions,
    pageCount: Number.isInteger(Number(item.result?.pageCount)) && Number(item.result?.pageCount) > 0
      ? Number(item.result.pageCount) : 0,
  };
}

function getFilteredPapers() {
  const query = state.query.trim().toLowerCase();
  const recentYear = new Date().getFullYear() - 2;
  return papers.filter((paper) => {
    const searchable = `${paper.year} ${paper.month} ${paper.set} ${paper.title} ${paper.tags.join(' ')}`.toLowerCase();
    const matchesQuery = !query || searchable.includes(query);
    const matchesFilter =
      state.filter === 'all' ||
      (state.filter === 'recent' && Number(paper.year) >= recentYear) ||
      (state.filter === 'listening' && paper.hasAudio) ||
      (state.filter === 'reading' && paper.hasQuestions);
    const matchesFavorite = !state.favoriteOnly || state.favorites.has(paper.id);
    return matchesQuery && matchesFilter && matchesFavorite;
  });
}

function renderPaperCard(paper) {
  const liked = state.favorites.has(paper.id);
  const progressText = paper.done === 100 ? '已交卷' : paper.done > 0 ? `已完成 ${paper.done}%` : paper.questions;
  const paperId = esc(paper.id);
  const cover = covers.includes(paper.cover) ? paper.cover : 'ocean';
  return `
    <article class="paper-card">
      <div class="paper-card-cover cover-${cover}">
        <div class="cover-top"><span>${esc(paper.year)} · ${esc(paper.month)}</span><span>用户上传</span></div>
        <div class="cover-label"><small>YOUR ENGLISH PAPER</small><strong>我的英语试卷</strong></div>
        <div class="cover-index">PDF</div>
      </div>
      <div class="paper-card-body">
        <div class="paper-card-title-row">
          <h4>${esc(paper.title)}</h4>
          <button class="favorite-button ${liked ? 'is-favorite' : ''}" type="button" data-favorite="${paperId}" aria-label="${liked ? '取消收藏' : '收藏试卷'}" aria-pressed="${liked}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20-7-6.3A4.7 4.7 0 0 1 11.3 7L12 8l.7-1A4.7 4.7 0 0 1 19 13.7L12 20Z" /></svg>
          </button>
        </div>
        <div class="paper-meta"><span>${esc(paper.tags[1])}</span><span class="difficulty">状态 · ${esc(paper.difficulty)}</span></div>
        <div class="paper-card-footer"><span>${esc(progressText)}</span><button class="open-paper" type="button" data-open-paper="${paperId}">${paper.done > 0 && paper.done < 100 ? '继续练习' : '查看试卷'}</button></div>
      </div>
    </article>`;
}

function renderPapers() {
  papers.forEach((paper) => { paper.done = storedPaperProgress(paper); });
  const matchingPapers = getFilteredPapers();
  const availableYears = [...new Set(papers.map((paper) => paper.year))]
    .sort((left, right) => Number(right) - Number(left));
  const scopedView = state.favoriteOnly || Boolean(state.query) || state.filter !== 'all';
  const visibleYears = state.showOlder || scopedView ? availableYears : availableYears.slice(0, 2);
  const filtered = matchingPapers.filter((paper) => visibleYears.includes(paper.year));
  const groups = visibleYears.map((year) => {
    const yearPapers = filtered.filter((paper) => paper.year === year);
    if (!yearPapers.length) return '';
    const periods = [...new Set(yearPapers.map((paper) => paper.period))];
    return `
      <section class="year-group" aria-labelledby="year-${esc(year)}">
        <div class="year-heading"><h3 id="year-${esc(year)}">${esc(year)} 年</h3><span></span><p>${periods.length === 2 ? '上半年 · 下半年' : esc(periods[0] || '')}</p></div>
        <div class="paper-grid">${yearPapers.map(renderPaperCard).join('')}</div>
      </section>`;
  }).join('');

  groupNode.innerHTML = groups;
  groupNode.setAttribute('aria-busy', String(state.catalogStatus === 'loading'));
  const noMatches = !filtered.length;
  emptyNode.hidden = !noMatches || state.catalogStatus === 'error';
  const emptyTitle = emptyNode.querySelector('h3');
  const emptyDescription = emptyNode.querySelector('p');
  const emptyUpload = document.querySelector('#empty-upload');
  const resetFilter = emptyNode.querySelector('.reset-button');
  if (state.catalogStatus === 'loading') {
    emptyTitle.textContent = '正在读取你的试卷';
    emptyDescription.textContent = '正在连接服务，读取已完成解析的上传记录。';
  } else if (!papers.length) {
    emptyTitle.textContent = state.pendingCount ? '已有上传记录待处理' : '从上传第一份试卷开始';
    emptyDescription.textContent = state.pendingCount
      ? '已有上传记录尚未生成可用试卷，请到上传页查看进度或处理结果。'
      : '平台提供阅读、答题、笔记与 AI 辅导；试卷 PDF、答案和听力音频由你提供。';
  } else {
    emptyTitle.textContent = '没有找到相符的试卷';
    emptyDescription.textContent = '换个关键词，或清除筛选条件再试一次。';
  }
  emptyUpload.hidden = Boolean(papers.length) || state.catalogStatus === 'loading';
  emptyUpload.textContent = state.pendingCount ? '查看上传记录' : '上传第一份试卷';
  resetFilter.hidden = !papers.length || state.catalogStatus === 'loading';
  catalogError.hidden = state.catalogStatus !== 'error';
  loadMoreButton.hidden = availableYears.length <= 2 || state.favoriteOnly || Boolean(state.query) || state.filter !== 'all';
  loadMoreButton.classList.toggle('open', state.showOlder);
  loadMoreButton.querySelector('span').textContent = state.showOlder ? '收起较早年份' : '展开更多年份';
  updateFavoriteCount();
  syncContinuePaper();
}

function updateFavoriteCount() {
  favoriteCount.textContent = String(papers.filter((paper) => state.favorites.has(paper.id)).length);
  try { localStorage.setItem('cet4-favorites', JSON.stringify([...state.favorites])); }
  catch { /* Browsing the catalog still works when browser storage is unavailable. */ }
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
    showToast('已从收藏中移除');
  } else {
    state.favorites.add(id);
    showToast('已加入我的收藏');
  }
  renderPapers();
  if (dialog.open) openPaper(id, true);
}

function paperSections(paper) {
  return [
    ['PDF', '原卷阅读与笔记', paper.pageCount ? `${paper.pageCount} 页 · 支持选择、标注与笔记` : '保留原卷版式，支持选择、标注与笔记'],
    ['Q', '在线作答', paper.hasQuestions ? `已识别 ${paper.questionCount} 道题目` : '暂未识别可交互题目，可先阅读原卷'],
    ['AI', '答案与辅导', paper.hasAnswer ? '已识别上传的答案资料' : '未识别到答案，AI 回复会说明依据'],
    ['♫', '听力播放', paper.hasAudio ? '已附用户上传的音频' : '未附听力音频'],
  ].map(([code, name, info]) => `<div class="paper-section-item"><span>${code}</span><div><b>${name}</b><small>${info}</small></div></div>`).join('');
}

function paperCapabilities(paper) {
  return [
    paper.hasQuestions ? '交互答题' : '原卷阅读',
    'AI 辅导',
    paper.hasAnswer ? '含答案' : '暂无答案',
    paper.hasAudio ? '含听力' : '未附听力',
  ].join(' · ');
}

function storedPaperProgress(paper) {
  const total = Number(paper?.questionCount);
  if (!paper?.runtimePaperId || !Number.isInteger(total) || total <= 0) return 0;
  try {
    const stored = JSON.parse(localStorage.getItem(`exam-viewer:${paper.runtimePaperId}:v1`) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return 0;
    if (stored.submitted === true) return 100;
    if (!stored.answers || typeof stored.answers !== 'object' || Array.isArray(stored.answers)) return 0;
    const answered = Object.entries(stored.answers).filter(([questionId, answer]) => (
      /^(?:q[1-9][0-9]{0,2}|writing-[1-9][0-9]{0,2}|translation-[1-9][0-9]{0,2})$/.test(questionId)
      && String(answer || '').trim()
    )).length;
    return Math.max(0, Math.min(99, Math.round((Math.min(answered, total) / total) * 100)));
  } catch {
    return 0;
  }
}

function hasStoredActivity(paper) {
  try {
    const stored = JSON.parse(localStorage.getItem(`exam-viewer:${paper.runtimePaperId}:v1`) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    return stored.submitted === true
      || Boolean(stored.currentQuestionId)
      || (Array.isArray(stored.annotations) && stored.annotations.length > 0)
      || (stored.answers && typeof stored.answers === 'object'
        && Object.values(stored.answers).some((answer) => String(answer || '').trim()))
      || (Array.isArray(stored.aiFreeHistory) && stored.aiFreeHistory.length > 0)
      || (Array.isArray(stored.aiSelectionHistory) && stored.aiSelectionHistory.length > 0)
      || (stored.aiHistory && typeof stored.aiHistory === 'object'
        && Object.values(stored.aiHistory).some((thread) => Array.isArray(thread) && thread.length > 0));
  } catch {
    return false;
  }
}

function openPaper(id, retainFocus = false) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  const liked = state.favorites.has(id);
  const progress = paper.done || 0;
  const cover = covers.includes(paper.cover) ? paper.cover : 'ocean';
  const paperId = esc(paper.id);
  dialogContent.innerHTML = `
    <header class="dialog-header cover-${cover}">
      <small>用户上传 · ${esc(paper.year)} 年 · ${esc(paper.period)}</small>
      <h2 id="dialog-paper-title">${esc(paper.title)}</h2>
      <p>${esc(paper.questions)} · ${esc(paperCapabilities(paper))}</p>
    </header>
    <div class="dialog-body">
      <div class="dialog-progress"><p>${hasStoredActivity(paper) ? '本卷已有学习记录，可随时继续。' : '使用你上传的资料练习，作答和笔记会自动保存。'}</p><strong>${progress ? `已完成 ${progress}%` : hasStoredActivity(paper) ? '已有记录' : '未开始'}</strong></div>
      <div class="section-list">${paperSections(paper)}</div>
      <div class="dialog-actions">
        <button class="favorite-button ${liked ? 'is-favorite' : ''}" data-label="${liked ? '已收藏' : '收藏试卷'}" type="button" data-favorite="${paperId}" aria-pressed="${liked}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20-7-6.3A4.7 4.7 0 0 1 11.3 7L12 8l.7-1A4.7 4.7 0 0 1 19 13.7L12 20Z" /></svg>
        </button>
        <button class="start-button" type="button" data-start-paper="${paperId}">${progress > 0 && progress < 100 ? '继续练习' : progress === 100 ? '查看复盘' : '打开我的试卷'} <span aria-hidden="true">→</span></button>
      </div>
    </div>`;
  backdrop.hidden = false;
  if (!dialog.open) dialog.showModal();
  if (!retainFocus) dialog.querySelector('.start-button').focus();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  backdrop.hidden = true;
}

function startPaper(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  closeDialog();
  window.location.href = unifiedReaderUrl(paper.runtimePaperId);
}

function syncContinuePaper() {
  const continueButton = document.querySelector('.continue-button');
  if (!continueButton) return;
  const target = papers.find(hasStoredActivity);
  continueButton.disabled = !target;
  if (target) continueButton.dataset.paperId = target.id;
  else delete continueButton.dataset.paperId;
  const description = document.querySelector('#records .progress-copy p');
  if (description) description.textContent = target
    ? `继续「${target.title}」，作答和笔记会在阅读器中自动保存。`
    : state.catalogStatus === 'error' ? '暂时无法读取试卷，请在下方重新连接服务。'
      : papers.length ? '打开下方试卷开始练习，保存后可以在这里继续。'
        : '上传自己的试卷后开始练习，作答和笔记会自动保存。';
  const progress = Math.max(0, Math.min(100, Number(target?.done) || 0));
  const value = document.querySelector('#continue-value');
  const bar = document.querySelector('#continue-bar');
  const progressNode = document.querySelector('.continue-progress');
  if (value) value.textContent = target ? (target.hasQuestions ? `${progress}%` : '已有记录') : '暂无记录';
  if (bar) bar.style.width = `${progress}%`;
  if (progressNode) progressNode.setAttribute('aria-label', target ? `当前练习进度 ${progress}%` : '尚无练习记录');
}

async function loadReadyExams() {
  if (retryExams.disabled) return;
  state.catalogStatus = 'loading';
  retryExams.disabled = true;
  renderPapers();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/exams', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`exam catalog request failed: ${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : payload?.exams;
    if (!Array.isArray(items)) throw new Error('Invalid exam catalog response');
    const seen = new Set();
    const readyPapers = items.flatMap((item) => {
      const paper = normalizeApiPaper(item);
      if (!paper || seen.has(paper.id)) return [];
      seen.add(paper.id);
      return [paper];
    });
    papers.splice(0, papers.length, ...readyPapers);
    state.pendingCount = items.filter((item) => item && item.status !== 'ready').length;
    state.catalogStatus = 'ready';
    updatePaperTotal();
    renderPapers();
  } catch (error) {
    state.catalogStatus = 'error';
    papers.splice(0, papers.length);
    updatePaperTotal();
    renderPapers();
    console.warn('Uploaded exam catalog unavailable.', error);
  } finally {
    window.clearTimeout(timeout);
    retryExams.disabled = false;
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#retry-exams')) {
    loadReadyExams();
    return;
  }
  if (event.target.closest('#upload-paper')) {
    window.location.href = 'upload.html';
    return;
  }
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) {
    toggleFavorite(favorite.dataset.favorite);
    return;
  }
  const openButton = event.target.closest('[data-open-paper], [data-paper-id]');
  if (openButton) {
    openPaper(openButton.dataset.openPaper || openButton.dataset.paperId);
    return;
  }
  const start = event.target.closest('[data-start-paper]');
  if (start) {
    startPaper(start.dataset.startPaper);
    return;
  }
  const toastButton = event.target.closest('[data-toast]');
  if (toastButton) showToast(toastButton.dataset.toast);
  const scrollButton = event.target.closest('[data-scroll]');
  if (scrollButton) document.querySelector(scrollButton.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' });
  if (event.target.closest('.reset-button')) {
    state.filter = 'all';
    state.query = '';
    state.favoriteOnly = false;
    searchInput.value = '';
    document.querySelectorAll('.filter-tab').forEach((tab) => {
      const active = tab.dataset.filter === 'all';
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    renderPapers();
  }
  if (event.target.closest('#show-favorites')) {
    state.favoriteOnly = !state.favoriteOnly;
    event.target.closest('#show-favorites').classList.toggle('active', state.favoriteOnly);
    showToast(state.favoriteOnly ? '正在查看收藏试卷' : '正在查看全部试卷');
    renderPapers();
  }
  if (event.target.closest('#load-more')) {
    state.showOlder = !state.showOlder;
    renderPapers();
  }
  if (event.target.closest('.dialog-close')) closeDialog();
  if (event.target.closest('.menu-button')) {
    const menu = document.querySelector('#mobile-nav');
    const isOpen = menu.classList.toggle('open');
    event.target.closest('.menu-button').setAttribute('aria-expanded', String(isOpen));
  }
  if (event.target.closest('.mobile-nav a')) {
    document.querySelector('#mobile-nav').classList.remove('open');
    document.querySelector('.menu-button').setAttribute('aria-expanded', 'false');
  }
});

document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    state.favoriteOnly = false;
    document.querySelectorAll('.filter-tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    renderPapers();
  });
});

searchInput.addEventListener('input', (event) => {
  state.query = event.target.value;
  state.favoriteOnly = false;
  renderPapers();
});

dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialog();
});
backdrop.addEventListener('click', closeDialog);

renderPapers();
loadReadyExams();
