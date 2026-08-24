const BUILT_IN_SOURCE_SHA256 = '688e243765c218d42d2a5fc5b54adb34247e6b3549da0a86ad2a39623d03a670';
const EXAM_ID_PATTERN = /^exam-[0-9]{8}-[0-9a-f]{12}$/;
const covers = ['ocean', 'coral', 'forest', 'violet', 'slate', 'gold'];

function unifiedReaderUrl(paperId) {
  return `reader.html?paper=${encodeURIComponent(String(paperId))}&cachefix=2`;
}

const builtInPaper = {
  id: '2021-06-01',
  runtimePaperId: '2021-06-01',
  year: '2021',
  period: '上半年',
  month: '06',
  set: '01',
  title: '2021 年 6 月四级真题（第 1 套）',
  tags: ['本地真题', '完整 8 页'],
  difficulty: '真题',
  cover: 'ocean',
  duration: '125 分钟',
  questions: '47 题',
  questionCount: 47,
  done: 0,
  hasAudio: false,
  hasAnswer: true,
  hasQuestions: true,
  isBuiltIn: true,
};
const papers = [builtInPaper];

const state = {
  filter: 'all',
  query: '',
  showOlder: false,
  favorites: loadFavorites(),
  favoriteOnly: false,
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
    tags: ['AI 在线试卷', hasAudio ? '含听力' : hasAnswer ? '含答案' : '完整原卷'],
    difficulty: hasAnswer ? '含解析' : '已生成',
    cover: coverForExam(examId),
    duration: '125 分钟',
    questions: hasQuestions ? `${total} 题` : '已解析',
    questionCount: hasQuestions ? total : 0,
    done: 0,
    hasAudio,
    hasAnswer,
    hasQuestions,
    isBuiltIn: false,
    paperSha256: /^[0-9a-f]{64}$/i.test(String(item.paperSha256 || '')) ? String(item.paperSha256).toLowerCase() : '',
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
  const progressText = paper.done === 100 ? '已完成' : paper.done > 0 ? `已完成 ${paper.done}%` : `${paper.duration} · ${paper.questions}`;
  const paperId = esc(paper.id);
  const cover = covers.includes(paper.cover) ? paper.cover : 'ocean';
  const coverKicker = paper.isBuiltIn ? 'CET-4 REAL PAPER' : 'AI ONLINE PAPER';
  const coverLabel = paper.isBuiltIn ? '四级完整真题' : 'AI 在线试卷';
  return `
    <article class="paper-card">
      <div class="paper-card-cover cover-${cover}">
        <div class="cover-top"><span>${esc(paper.year)} · ${esc(paper.month)}</span><span>SET ${esc(paper.set)}</span></div>
        <div class="cover-label"><small>${coverKicker}</small><strong>${coverLabel}</strong></div>
        <div class="cover-index">${esc(paper.set)}</div>
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
  const featuredPapers = matchingPapers.filter((paper) => paper.isBuiltIn);
  const availableYears = [...new Set(papers.filter((paper) => !paper.isBuiltIn).map((paper) => paper.year))]
    .sort((left, right) => Number(right) - Number(left));
  const scopedView = state.favoriteOnly || Boolean(state.query) || state.filter !== 'all';
  const visibleYears = state.showOlder || scopedView ? availableYears : availableYears.slice(0, 2);
  const filtered = matchingPapers.filter((paper) => !paper.isBuiltIn && visibleYears.includes(paper.year));
  const featured = featuredPapers.length ? `
    <section class="year-group" aria-labelledby="year-local-real">
      <div class="year-heading"><h3 id="year-local-real">本地完整真题</h3><span></span><p>2021 年 6 月 · 8 页原卷</p></div>
      <div class="paper-grid">${featuredPapers.map(renderPaperCard).join('')}</div>
    </section>` : '';
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

  groupNode.innerHTML = featured + groups;
  const noMatches = !featuredPapers.length && !filtered.length;
  emptyNode.hidden = !noMatches;
  loadMoreButton.hidden = availableYears.length <= 2 || state.favoriteOnly || Boolean(state.query) || state.filter !== 'all';
  loadMoreButton.classList.toggle('open', state.showOlder);
  loadMoreButton.querySelector('span').textContent = state.showOlder ? '收起较早年份' : '展开更多年份';
  updateFavoriteCount();
  syncContinuePaper();
}

function updateFavoriteCount() {
  favoriteCount.textContent = String(papers.filter((paper) => state.favorites.has(paper.id)).length);
  localStorage.setItem('cet4-favorites', JSON.stringify([...state.favorites]));
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
    ['A', '写作', '30 分钟 · 1 题'],
    ['B', '听力理解', '25 分钟 · 25 题'],
    ['C', '阅读理解', '40 分钟 · 30 题'],
    ['D', '翻译', '30 分钟 · 1 题'],
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

function openPaper(id, retainFocus = false) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  const liked = state.favorites.has(id);
  const progress = paper.done || 0;
  const cover = covers.includes(paper.cover) ? paper.cover : 'ocean';
  const paperId = esc(paper.id);
  dialogContent.innerHTML = `
    <header class="dialog-header cover-${cover}">
      <small>${esc(paper.year)} 年 · ${esc(paper.period)} · SET ${esc(paper.set)}</small>
      <h2 id="dialog-paper-title">${esc(paper.title)}</h2>
      <p>${esc(paper.duration)} · ${esc(paper.questions)} · ${esc(paperCapabilities(paper))}</p>
    </header>
    <div class="dialog-body">
      <div class="dialog-progress"><p>${progress ? '本卷已有学习记录，可随时继续。' : '按真实考试顺序组织，开始后将自动保存。'}</p><strong>${progress ? `已完成 ${progress}%` : '未开始'}</strong></div>
      <div class="section-list">${paperSections(paper)}</div>
      <div class="dialog-actions">
        <button class="favorite-button ${liked ? 'is-favorite' : ''}" data-label="${liked ? '已收藏' : '收藏试卷'}" type="button" data-favorite="${paperId}" aria-pressed="${liked}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20-7-6.3A4.7 4.7 0 0 1 11.3 7L12 8l.7-1A4.7 4.7 0 0 1 19 13.7L12 20Z" /></svg>
        </button>
        <button class="start-button" type="button" data-start-paper="${paperId}">${progress > 0 && progress < 100 ? '继续练习' : progress === 100 ? '查看复盘' : '开始整套练习'} <span aria-hidden="true">→</span></button>
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
  const target = papers.find((paper) => !paper.isBuiltIn) || builtInPaper;
  if (!continueButton || !target) return;
  continueButton.dataset.paperId = target.id;
  const description = document.querySelector('#records .progress-copy p');
  if (description) description.textContent = `继续「${target.title}」，进度会在完整试卷阅读器中自动保存。`;
  const progress = Math.max(0, Math.min(100, Number(target.done) || 0));
  const value = document.querySelector('#continue-value');
  const bar = document.querySelector('#continue-bar');
  const progressNode = document.querySelector('.continue-progress');
  if (value) value.textContent = `${progress}%`;
  if (bar) bar.style.width = `${progress}%`;
  if (progressNode) progressNode.setAttribute('aria-label', `当前练习进度 ${progress}%`);
}

async function loadReadyExams() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/exams', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`exam catalog request failed: ${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.exams) ? payload.exams : [];
    const seen = new Set();
    const readyPapers = items.flatMap((item) => {
      const paper = normalizeApiPaper(item);
      if (!paper || seen.has(paper.id)) return [];
      seen.add(paper.id);
      return [paper];
    });
    const builtInRuntime = readyPapers.find((paper) => paper.paperSha256 === BUILT_IN_SOURCE_SHA256);
    if (builtInRuntime) {
      builtInPaper.hasAudio ||= builtInRuntime.hasAudio;
      builtInPaper.hasAnswer ||= builtInRuntime.hasAnswer;
      if (builtInRuntime.questionCount > 0) {
        builtInPaper.hasQuestions = true;
        builtInPaper.questionCount = builtInRuntime.questionCount;
        builtInPaper.questions = builtInRuntime.questions;
      }
      builtInPaper.difficulty = builtInPaper.hasAnswer ? '含解析' : '已生成';
      builtInPaper.tags = ['本地真题', builtInPaper.hasAudio
        ? (builtInPaper.hasAnswer ? '含听力与答案' : '含听力')
        : (builtInPaper.hasAnswer ? '含答案' : '完整 8 页')];
    }
    const imported = readyPapers.filter((paper) => paper.paperSha256 !== BUILT_IN_SOURCE_SHA256);
    papers.splice(1, papers.length - 1, ...imported);
    updatePaperTotal();
    renderPapers();
  } catch (error) {
    console.warn('Ready exam catalog unavailable; using the built-in paper only.', error);
  } finally {
    window.clearTimeout(timeout);
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

document.addEventListener('click', (event) => {
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
