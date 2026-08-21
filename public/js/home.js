const papers = [
  { id: '2021-06-01', year: '2021', period: '上半年', month: '06', set: '01', title: '2021 年 6 月四级真题（第 1 套）', tags: ['本地真题', '完整 8 页'], difficulty: '真题', cover: 'ocean', duration: '125 分钟', questions: '57 题', done: 0, isRealPaper: true },
  { id: '2025-12-01', year: '2025', period: '下半年', month: '12', set: '01', title: '2025 年 12 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '适中', cover: 'ocean', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2025-12-02', year: '2025', period: '下半年', month: '12', set: '02', title: '2025 年 12 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '适中', cover: 'coral', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2025-12-03', year: '2025', period: '下半年', month: '12', set: '03', title: '2025 年 12 月四级模拟卷（第 3 套）', tags: ['整套训练', '写作练习'], difficulty: '进阶', cover: 'forest', duration: '125 分钟', questions: '57 题', done: 18 },
  { id: '2025-06-01', year: '2025', period: '上半年', month: '06', set: '01', title: '2025 年 6 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '适中', cover: 'violet', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2025-06-02', year: '2025', period: '上半年', month: '06', set: '02', title: '2025 年 6 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '适中', cover: 'slate', duration: '125 分钟', questions: '57 题', done: 46 },
  { id: '2025-06-03', year: '2025', period: '上半年', month: '06', set: '03', title: '2025 年 6 月四级模拟卷（第 3 套）', tags: ['整套训练', '翻译练习'], difficulty: '进阶', cover: 'gold', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2024-12-01', year: '2024', period: '下半年', month: '12', set: '01', title: '2024 年 12 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '适中', cover: 'forest', duration: '125 分钟', questions: '57 题', done: 100 },
  { id: '2024-12-02', year: '2024', period: '下半年', month: '12', set: '02', title: '2024 年 12 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '进阶', cover: 'ocean', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2024-12-03', year: '2024', period: '下半年', month: '12', set: '03', title: '2024 年 12 月四级模拟卷（第 3 套）', tags: ['整套训练', '写作练习'], difficulty: '适中', cover: 'coral', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2024-06-01', year: '2024', period: '上半年', month: '06', set: '01', title: '2024 年 6 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '进阶', cover: 'gold', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2024-06-02', year: '2024', period: '上半年', month: '06', set: '02', title: '2024 年 6 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '适中', cover: 'violet', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2024-06-03', year: '2024', period: '上半年', month: '06', set: '03', title: '2024 年 6 月四级模拟卷（第 3 套）', tags: ['整套训练', '翻译练习'], difficulty: '适中', cover: 'slate', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-12-01', year: '2023', period: '下半年', month: '12', set: '01', title: '2023 年 12 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '基础', cover: 'coral', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-12-02', year: '2023', period: '下半年', month: '12', set: '02', title: '2023 年 12 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '适中', cover: 'forest', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-12-03', year: '2023', period: '下半年', month: '12', set: '03', title: '2023 年 12 月四级模拟卷（第 3 套）', tags: ['整套训练', '写作练习'], difficulty: '进阶', cover: 'ocean', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-06-01', year: '2023', period: '上半年', month: '06', set: '01', title: '2023 年 6 月四级模拟卷（第 1 套）', tags: ['整套训练', '听力重点'], difficulty: '基础', cover: 'slate', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-06-02', year: '2023', period: '上半年', month: '06', set: '02', title: '2023 年 6 月四级模拟卷（第 2 套）', tags: ['整套训练', '阅读重点'], difficulty: '适中', cover: 'gold', duration: '125 分钟', questions: '57 题', done: 0 },
  { id: '2023-06-03', year: '2023', period: '上半年', month: '06', set: '03', title: '2023 年 6 月四级模拟卷（第 3 套）', tags: ['整套训练', '翻译练习'], difficulty: '进阶', cover: 'violet', duration: '125 分钟', questions: '57 题', done: 0 }
];

const state = {
  filter: 'all',
  query: '',
  showOlder: false,
  favorites: new Set(JSON.parse(localStorage.getItem('cet4-favorites') || '[]')),
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

paperTotal.textContent = papers.length;

function esc(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function getFilteredPapers() {
  const query = state.query.trim().toLowerCase();
  return papers.filter((paper) => {
    const searchable = `${paper.year} ${paper.month} ${paper.set} ${paper.title} ${paper.tags.join(' ')}`.toLowerCase();
    const matchesQuery = !query || searchable.includes(query);
    const matchesFilter =
      state.filter === 'all' ||
      (state.filter === 'recent' && Number(paper.year) >= 2023) ||
      (state.filter === 'listening' && paper.tags.includes('听力重点')) ||
      (state.filter === 'reading' && paper.tags.includes('阅读重点'));
    const matchesFavorite = !state.favoriteOnly || state.favorites.has(paper.id);
    return matchesQuery && matchesFilter && matchesFavorite;
  });
}

function renderPaperCard(paper) {
  const liked = state.favorites.has(paper.id);
  const progressText = paper.done === 100 ? '已完成' : paper.done > 0 ? `已完成 ${paper.done}%` : `${paper.duration} · ${paper.questions}`;
  return `
    <article class="paper-card">
      <div class="paper-card-cover cover-${paper.cover}">
        <div class="cover-top"><span>${paper.year} · ${paper.month}</span><span>SET ${paper.set}</span></div>
        <div class="cover-label"><small>${paper.isRealPaper ? 'CET-4 REAL PAPER' : 'CET-4 PRACTICE'}</small><strong>${paper.isRealPaper ? '四级完整真题' : '四级模拟卷'}</strong></div>
        <div class="cover-index">${paper.set}</div>
      </div>
      <div class="paper-card-body">
        <div class="paper-card-title-row">
          <h4>${esc(paper.title)}</h4>
          <button class="favorite-button ${liked ? 'is-favorite' : ''}" type="button" data-favorite="${paper.id}" aria-label="${liked ? '取消收藏' : '收藏试卷'}" aria-pressed="${liked}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20-7-6.3A4.7 4.7 0 0 1 11.3 7L12 8l.7-1A4.7 4.7 0 0 1 19 13.7L12 20Z" /></svg>
          </button>
        </div>
        <div class="paper-meta"><span>${paper.tags[1]}</span><span class="difficulty">难度 · ${paper.difficulty}</span></div>
        <div class="paper-card-footer"><span>${progressText}</span><button class="open-paper" type="button" data-open-paper="${paper.id}">${paper.done > 0 && paper.done < 100 ? '继续练习' : '查看试卷'}</button></div>
      </div>
    </article>`;
}

function renderPapers() {
  const visibleYears = state.showOlder ? ['2025', '2024', '2023'] : ['2025', '2024'];
  const matchingPapers = getFilteredPapers();
  const featuredPapers = matchingPapers.filter((paper) => paper.isRealPaper);
  const filtered = matchingPapers.filter((paper) => !paper.isRealPaper && visibleYears.includes(paper.year));
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
      <section class="year-group" aria-labelledby="year-${year}">
        <div class="year-heading"><h3 id="year-${year}">${year} 年</h3><span></span><p>${periods.length === 2 ? '上半年 · 下半年' : periods[0]}</p></div>
        <div class="paper-grid">${yearPapers.map(renderPaperCard).join('')}</div>
      </section>`;
  }).join('');

  groupNode.innerHTML = featured + groups;
  const noMatches = !featuredPapers.length && !filtered.length;
  emptyNode.hidden = !noMatches;
  loadMoreButton.hidden = state.favoriteOnly || Boolean(state.query) || state.filter !== 'all';
  loadMoreButton.classList.toggle('open', state.showOlder);
  loadMoreButton.querySelector('span').textContent = state.showOlder ? '收起较早年份' : '展开更多年份';
  updateFavoriteCount();
}

function updateFavoriteCount() {
  favoriteCount.textContent = String(state.favorites.size);
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

function openPaper(id, retainFocus = false) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  const liked = state.favorites.has(id);
  const progress = paper.done || 0;
  dialogContent.innerHTML = `
    <header class="dialog-header cover-${paper.cover}">
      <small>${paper.year} 年 · ${paper.period} · SET ${paper.set}</small>
      <h2 id="dialog-paper-title">${esc(paper.title)}</h2>
      <p>${paper.duration} · ${paper.questions} · 含听力、阅读、翻译、写作</p>
    </header>
    <div class="dialog-body">
      <div class="dialog-progress"><p>${progress ? '本卷已有学习记录，可随时继续。' : '按真实考试顺序组织，开始后将自动保存。'}</p><strong>${progress ? `已完成 ${progress}%` : '未开始'}</strong></div>
      <div class="section-list">${paperSections(paper)}</div>
      <div class="dialog-actions">
        <button class="favorite-button ${liked ? 'is-favorite' : ''}" data-label="${liked ? '已收藏' : '收藏试卷'}" type="button" data-favorite="${paper.id}" aria-pressed="${liked}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 20-7-6.3A4.7 4.7 0 0 1 11.3 7L12 8l.7-1A4.7 4.7 0 0 1 19 13.7L12 20Z" /></svg>
        </button>
        <button class="start-button" type="button" data-start-paper="${paper.id}">${progress > 0 && progress < 100 ? '继续练习' : progress === 100 ? '查看复盘' : '开始整套练习'} <span aria-hidden="true">→</span></button>
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
  if (paper.done === 0) paper.done = 2;
  if (id === '2025-06-02') {
    paper.done = Math.max(paper.done, 47);
    document.querySelector('#continue-value').textContent = '47%';
    document.querySelector('#continue-bar').style.width = '47%';
  }
  closeDialog();
  renderPapers();
  const targetPage = paper.isRealPaper ? 'reader.html' : 'practice.html';
  window.location.href = `${targetPage}?paper=${encodeURIComponent(paper.id)}`;
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
