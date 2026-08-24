/*
 * Shared word-lookup card used by both reader.html and practice.html.
 *
 * One small vanilla-JS module owns the whole lifecycle of the popup card:
 * dictionary lookup (/api/dictionary), licensed human pronunciation
 * (/api/pronunciation), flite fallback (/api/tts), browser
 * speechSynthesis as the last resort, and the Chinese gloss (MyMemory,
 * kept exactly as before).  No frameworks, no build step.
 */
(() => {
  'use strict';

  const DICTIONARY_ENDPOINT = '/api/dictionary';
  const PRONUNCIATION_ENDPOINT = '/api/pronunciation';
  const TTS_ENDPOINT = '/api/tts';
  const ACCENT_LABELS = { uk: '英音', us: '美音', au: '澳音' };
  const ACCENT_PRIORITY = ['uk', 'us', 'au'];
  const MOBILE_QUERY = '(max-width: 680px)';
  const FETCH_TIMEOUT_MS = 12000;
  const MAX_DEFINITIONS_SHOWN = 3;

  const translationCache = new Map();
  const query = (selector, context = document) => context.querySelector(selector);

  function cleanWord(value) {
    const normalized = String(value ?? '').replace(/\u00a0/g, ' ').trim();
    const match = normalized.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/);
    return match ? match[0].replace(/’/g, "'") : '';
  }

  function decodeHtmlText(value) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = String(value || '');
    return decoder.value.trim();
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload?.error || `request failed: ${response.status}`));
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getTranslation(word) {
    const key = cleanWord(word).toLowerCase();
    if (!key) throw new Error('invalid lookup word');
    if (translationCache.has(key)) return translationCache.get(key);
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=en%7Czh-CN`);
    if (!response.ok) throw new Error(`translation request failed: ${response.status}`);
    const data = await response.json();
    const translation = decodeHtmlText(data?.responseData?.translatedText);
    if (!translation) throw new Error('empty translation');
    translationCache.set(key, translation);
    return translation;
  }

  function makeElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = text;
    return element;
  }

  const SPEAKER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 4V6L8 10z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';

  function create(options = {}) {
    const host = options;
    let token = 0;
    let isOpen = false;
    let currentWord = '';
    let currentTarget = null;
    let autoPlayed = false;
    let syntheticPlayback = false;
    let audioElement = null;

    const card = makeElement('section', 'wl-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '单词释义与发音');
    card.setAttribute('aria-hidden', 'true');

    const closeButton = makeElement('button', 'wl-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭单词卡');
    const kicker = makeElement('p', 'wl-kicker', 'WORD LOOKUP');
    const wordHeading = makeElement('h2', 'wl-word');
    const statusNode = makeElement('p', 'wl-status');
    statusNode.setAttribute('role', 'status');
    statusNode.setAttribute('aria-live', 'polite');
    const phoneticsNode = makeElement('div', 'wl-phonetics');
    const translationBlock = makeElement('div', 'wl-translation-block');
    translationBlock.append(makeElement('b', '', '中文释义'));
    const translationNode = makeElement('p', 'wl-translation');
    translationBlock.append(translationNode);
    const meaningsNode = makeElement('div', 'wl-meanings');
    meaningsNode.hidden = true;
    const sourceNode = makeElement('footer', 'wl-source');
    const actionsSlot = makeElement('div', 'wl-actions');
    card.append(closeButton, kicker, wordHeading, statusNode, phoneticsNode, translationBlock, meaningsNode, sourceNode, actionsSlot);

    function stopPlayback() {
      if (audioElement) {
        audioElement.pause();
        audioElement.removeAttribute('src');
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    function ensureAudioElement() {
      if (!audioElement && typeof Audio === 'function') audioElement = new Audio();
      return audioElement;
    }

    function speakWithBrowser(word) {
      if (!word || !('speechSynthesis' in window)) return false;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = 'en-GB';
      utterance.rate = 0.86;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
      return true;
    }

    function renderSyntheticBadge(reason) {
      const existing = query('.wl-synth-badge', card);
      const showReason = reason || (syntheticPlayback ? '本地合成发音（真人录音暂不可用）' : '');
      if (!showReason) {
        existing?.remove();
        return;
      }
      let badge = existing;
      if (!badge) {
        badge = makeElement('p', 'wl-synth-badge');
        const playButton = makeElement('button', 'wl-synth-play');
        playButton.type = 'button';
        playButton.setAttribute('aria-label', '播放本地合成发音');
        playButton.innerHTML = `${SPEAKER_SVG}<span>播放</span>`;
        playButton.addEventListener('click', () => playSynthetic());
        badge.append(makeElement('span', 'wl-synth-text'), playButton);
      }
      query('.wl-synth-text', badge).textContent = showReason;
      phoneticsNode.after(badge);
    }

    function markSynthetic(reason) {
      syntheticPlayback = true;
      renderSyntheticBadge(reason);
    }

    function playSynthetic() {
      const word = currentWord;
      if (!word) return;
      markSynthetic('本地合成发音（无开放真人录音）');
      const element = ensureAudioElement();
      const useSpeech = () => {
        if (token !== liveTokenValue() || word !== currentWord) return;
        if (!speakWithBrowser(word)) console.warn('word-lookup: no pronunciation channel available for', word);
      };
      if (!element) {
        useSpeech();
        return;
      }
      stopPlayback();
      element.onerror = () => {
        element.onerror = null;
        useSpeech();
      };
      element.src = `${TTS_ENDPOINT}?word=${encodeURIComponent(word.toLowerCase())}`;
      const playback = element.play();
      if (playback?.catch) playback.catch(useSpeech);
    }

    function playableAccents(data) {
      return ACCENT_PRIORITY.filter((accent) => (
        (data?.phonetics || []).some((item) => item.accent === accent && item.audioUrl)
      ));
    }

    function maybeAutoPlay(data) {
      if (autoPlayed || !isOpen) return;
      autoPlayed = true;
      const accents = playableAccents(data);
      if (accents.length) {
        playAccent(accents[0]);
        return;
      }
      playSynthetic();
    }

    function playAccent(accent) {
      const word = currentWord;
      if (!word || !accent) return;
      const element = ensureAudioElement();
      if (!element) {
        playSynthetic();
        return;
      }
      stopPlayback();
      const fallback = () => {
        if (token === liveTokenValue() && word === currentWord) playSynthetic();
      };
      element.onerror = fallback;
      element.src = `${PRONUNCIATION_ENDPOINT}?word=${encodeURIComponent(word.toLowerCase())}&accent=${encodeURIComponent(accent)}`;
      const playback = element.play();
      if (playback?.catch) playback.catch(fallback);
    }

    function liveTokenValue() { return token; }

    function renderPhonetics(data) {
      phoneticsNode.replaceChildren();
      ACCENT_PRIORITY.forEach((accent) => {
        const entry = (data?.phonetics || []).find((item) => item.accent === accent);
        const ipa = String(entry?.ipa || '').trim();
        const hasAudio = Boolean(entry?.audioUrl);
        if (!ipa && !hasAudio) return;
        const row = makeElement('div', 'wl-accent-row');
        row.append(makeElement('span', 'wl-accent-label', ACCENT_LABELS[accent]));
        if (ipa) row.append(makeElement('span', 'wl-ipa', ipa));
        if (hasAudio) {
          const playButton = makeElement('button', 'wl-play');
          playButton.type = 'button';
          playButton.dataset.wlAccent = accent;
          playButton.setAttribute('aria-label', `播放${ACCENT_LABELS[accent]}真人发音`);
          playButton.innerHTML = `${SPEAKER_SVG}<span>${ACCENT_LABELS[accent]}</span>`;
          playButton.addEventListener('click', () => playAccent(accent));
          row.append(playButton);
        }
        phoneticsNode.append(row);
      });
      const humanAvailable = playableAccents(data).length > 0;
      renderSyntheticBadge(humanAvailable ? '' : '本地合成发音（无开放真人录音）');
    }

    function renderMeanings(data) {
      meaningsNode.replaceChildren();
      let shown = 0;
      (data?.meanings || []).every((meaning) => {
        if (shown >= MAX_DEFINITIONS_SHOWN) return false;
        const partOfSpeech = String(meaning?.partOfSpeech || '').trim();
        const definitions = Array.isArray(meaning?.definitions) ? meaning.definitions : [];
        if (!definitions.length) return true;
        const group = makeElement('div', 'wl-meaning');
        if (partOfSpeech) group.append(makeElement('span', 'wl-pos', partOfSpeech));
        const list = makeElement('ul', 'wl-definitions');
        let example = '';
        definitions.some((item) => {
          if (shown >= MAX_DEFINITIONS_SHOWN) return true;
          const text = String(item?.definition || '').trim();
          if (!text) return false;
          list.append(makeElement('li', '', text));
          if (!example && item?.example) example = String(item.example).trim();
          shown += 1;
          return shown < MAX_DEFINITIONS_SHOWN;
        });
        if (list.children.length) group.append(list);
        if (example) group.append(makeElement('p', 'wl-example', `例：${example}`));
        if (group.children.length) meaningsNode.append(group);
        return shown < MAX_DEFINITIONS_SHOWN;
      });
      meaningsNode.hidden = !meaningsNode.children.length;
    }

    function renderSource(data) {
      sourceNode.replaceChildren();
      sourceNode.append(makeElement('span', 'wl-provider', `数据来源：${String(data?.provider || '').trim() || 'Free Dictionary API'}`));
      const licenses = new Map();
      (data?.phonetics || []).forEach((item) => {
        const name = String(item?.license?.name || '').trim();
        const url = String(item?.license?.url || '').trim();
        const origin = String(item?.sourceUrl || '').trim();
        if (name && url && !licenses.has(`${name}|${url}|${origin}`)) {
          licenses.set(`${name}|${url}|${origin}`, { name, url, origin });
        }
      });
      if (!licenses.size) {
        sourceNode.append(makeElement('span', 'wl-license', '无真人录音许可信息'));
        return;
      }
      licenses.forEach(({ name, url, origin }) => {
        const line = makeElement('span', 'wl-license');
        line.append('音频许可证：');
        const licenseLink = document.createElement('a');
        licenseLink.href = url;
        licenseLink.target = '_blank';
        licenseLink.rel = 'noreferrer noopener';
        licenseLink.textContent = name;
        line.append(licenseLink);
        if (origin) {
          line.append(' · ');
          const sourceLink = document.createElement('a');
          sourceLink.href = origin;
          sourceLink.target = '_blank';
          sourceLink.rel = 'noreferrer noopener';
          sourceLink.textContent = '原始来源';
          line.append(sourceLink);
        }
        sourceNode.append(line);
      });
    }

    function setStatus(message) {
      statusNode.textContent = message;
      statusNode.hidden = !message;
    }

    function requestIsCurrent(requestToken, word) {
      return requestToken === token && isOpen && currentWord === word;
    }

    async function loadDictionary(word, requestToken) {
      setStatus('正在查询词典与发音…');
      try {
        const data = await fetchJson(`${DICTIONARY_ENDPOINT}?word=${encodeURIComponent(word.toLowerCase())}`);
        if (!requestIsCurrent(requestToken, word)) return;
        renderPhonetics(data);
        renderMeanings(data);
        renderSource(data);
        setStatus('');
        maybeAutoPlay(data);
      } catch {
        if (!requestIsCurrent(requestToken, word)) return;
        phoneticsNode.replaceChildren();
        renderSyntheticBadge('');
        meaningsNode.hidden = true;
        renderSource({});
        setStatus('英文词典暂时不可用，仍可使用合成朗读。');
        maybeAutoPlay(null);
      }
    }

    async function loadTranslation(word, requestToken) {
      translationNode.textContent = '正在查询中文释义…';
      try {
        const translation = await getTranslation(word);
        if (!requestIsCurrent(requestToken, word)) return;
        translationNode.textContent = translation;
      } catch {
        if (!requestIsCurrent(requestToken, word)) return;
        translationNode.textContent = '在线中文释义暂时不可用。';
      }
    }

    function positionCard() {
      if (matchMedia(MOBILE_QUERY).matches) {
        card.style.removeProperty('left');
        card.style.removeProperty('top');
        return;
      }
      if (!currentTarget?.isConnected) return;
      const targetBox = currentTarget.getBoundingClientRect();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const left = Math.min(
        Math.max(targetBox.left + targetBox.width / 2 - width / 2, 12),
        Math.max(12, window.innerWidth - width - 12),
      );
      const preferredTop = targetBox.bottom + height + 10 > window.innerHeight
        ? targetBox.top - height - 10
        : targetBox.bottom + 10;
      card.style.left = `${left}px`;
      card.style.top = `${Math.min(Math.max(preferredTop, 12), Math.max(12, window.innerHeight - height - 12))}px`;
    }

    function handleRepositionEvent() {
      if (!isOpen) return;
      if (currentTarget && !currentTarget.isConnected) {
        hide();
        return;
      }
      positionCard();
    }

    function handleDocumentPointerDown(event) {
      if (!isOpen) return;
      if (card.contains(event.target)) return;
      if (currentTarget && (event.target === currentTarget || currentTarget.contains(event.target))) return;
      hide();
    }

    function handleKeydown(event) {
      if (event.key === 'Escape' && isOpen) {
        event.stopPropagation();
        hide();
      }
    }

    function attachGlobalListeners() {
      window.addEventListener('resize', handleRepositionEvent);
      window.addEventListener('scroll', handleRepositionEvent, true);
      document.addEventListener('pointerdown', handleDocumentPointerDown, true);
      document.addEventListener('keydown', handleKeydown, true);
    }

    function detachGlobalListeners() {
      window.removeEventListener('resize', handleRepositionEvent);
      window.removeEventListener('scroll', handleRepositionEvent, true);
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleKeydown, true);
    }

    closeButton.addEventListener('click', () => hide());

    function resetCard(word) {
      wordHeading.textContent = word;
      phoneticsNode.replaceChildren();
      query('.wl-synth-badge', card)?.remove();
      meaningsNode.replaceChildren();
      meaningsNode.hidden = true;
      sourceNode.replaceChildren();
      translationNode.textContent = '';
      setStatus('正在查询单词…');
    }

    function show(target, rawValue) {
      const word = cleanWord(rawValue ?? target?.dataset?.word ?? target?.textContent);
      if (!word) return;
      hide({ notifyHost: false });
      token += 1;
      const requestToken = token;
      isOpen = true;
      currentWord = word;
      currentTarget = target || null;
      autoPlayed = false;
      syntheticPlayback = false;
      resetCard(word);
      currentTarget?.classList?.add('wl-target-active');
      document.body.append(card);
      card.classList.add('is-open');
      card.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(positionCard);
      attachGlobalListeners();
      host.onOpen?.({ word, target: currentTarget, actionsSlot });
      loadDictionary(word, requestToken);
      loadTranslation(word, requestToken);
    }

    function hide({ notifyHost = true } = {}) {
      token += 1;
      if (!isOpen && !card.classList.contains('is-open')) {
        if (notifyHost) host.onClose?.();
        return;
      }
      isOpen = false;
      currentTarget?.classList?.remove('wl-target-active');
      currentTarget = null;
      stopPlayback();
      detachGlobalListeners();
      card.classList.remove('is-open');
      card.setAttribute('aria-hidden', 'true');
      card.remove();
      if (notifyHost) host.onClose?.();
    }

    return {
      open: show,
      close: () => hide(),
      hide,
      isOpen: () => isOpen,
      get currentWord() { return currentWord; },
      element: card,
      actionsSlot,
    };
  }

  window.WordLookup = { create, cleanWord };
})();
