// ==UserScript==
// @name         Twitch Chat Translator
// @namespace    twitch-chat-translator
// @version      1.7.0
// @description  Translates Twitch chat messages to a chosen language, and lets you type in English and convert to other languages.
// @author       You
// @match        https://www.twitch.tv/*
// @match        https://dashboard.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      translate.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LANGS = [
    ['auto', 'Auto detect'],
    ['en', 'English'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh-CN', 'Chinese (Simplified)'],
    ['zh-TW', 'Chinese (Traditional)'],
    ['it', 'Italian'],
    ['tr', 'Turkish'],
    ['ar', 'Arabic'],
    ['pl', 'Polish'],
    ['nl', 'Dutch'],
    ['sv', 'Swedish'],
    ['th', 'Thai'],
    ['vi', 'Vietnamese'],
    ['id', 'Indonesian'],
    ['tl', 'Filipino'],
    ['hi', 'Hindi'],
    ['cs', 'Czech'],
    ['ro', 'Romanian'],
    ['hu', 'Hungarian'],
    ['el', 'Greek'],
    ['he', 'Hebrew'],
    ['uk', 'Ukrainian'],
    ['fi', 'Finnish'],
    ['no', 'Norwegian'],
    ['da', 'Danish'],
  ];

  const LANG_NAME = Object.fromEntries(LANGS.map(([c, n]) => [c, n]));

  const SETTINGS_KEY = 'tt_chat_settings';
  const defaultSettings = {
    enabled: true,
    incomingLang: 'en',
    outgoingLang: 'es',
    sourceLang: 'auto',
    autoDetectStream: true,
    panelOpen: false,
  };
  function loadSettings() {
    try { return Object.assign({}, defaultSettings, JSON.parse(GM_getValue(SETTINGS_KEY, '{}'))); }
    catch (e) { return Object.assign({}, defaultSettings); }
  }
  function saveSettings(s) { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); }
  let settings = loadSettings();

  const cache = new Map();
  const MAX_CACHE = 10000;
  const queue = [];
  const inflight = new Map();
  let active = 0;
  const MAX_CONC = 8;
  const MAX_QUEUE = 120;
  let delay = 60;
  const MIN_DELAY = 40;
  const MAX_DELAY = 800;


  function googleTranslate(text, sourceLang, targetLang) {
    sourceLang = sourceLang || 'auto';
    targetLang = targetLang || 'en';
    return new Promise((resolve, reject) => {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
        encodeURIComponent(sourceLang) + '&tl=' + encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 12000,
        onload: (r) => {
          try {
            const data = JSON.parse(r.responseText);
            const out = (data[0] || []).map(x => x[0] || '').join('');
            resolve(out || text);
          } catch (e) { reject(e); }
        },
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function cacheKey(text, sourceLang, targetLang) {
    return sourceLang + '|' + targetLang + '|' + text;
  }

  const COMMON_EN = new Set(['the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he','as','you','do','at','this','but','his','by','from','they','we','say','her','she','or','an','will','my','one','all','would','there','their','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','people','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','work','first','well','way','even','new','want','because','any','these','give','day','most','us','is','are','was','were','has','had','did','does']);
  function looksEnglish(text) {
    const words = text.toLowerCase().match(/[a-z']+/g) || [];
    if (!words.length) return false;
    let hits = 0;
    for (const w of words) if (COMMON_EN.has(w)) hits++;
    // If at least one common English word, or single short ASCII token, treat as English.
    return hits > 0 || (words.length === 1 && words[0].length <= 4);
  }
  function doTranslate(text, targetLang, sourceLang, skipIfAscii) {
    text = (text || '').trim();
    if (!text) return Promise.resolve('');
    targetLang = targetLang || settings.incomingLang || 'en';
    sourceLang = sourceLang || 'auto';
    // Fast path (incoming only): ASCII text targeting English is assumed already English.
    if (skipIfAscii && targetLang === 'en' && sourceLang === 'auto' && /^[\x20-\x7E]+$/.test(text) && looksEnglish(text)) {
      return Promise.resolve(text);
    }
    const key = cacheKey(text, sourceLang, targetLang);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    if (queue.length >= MAX_QUEUE) {
      // Under heavy load, drop oldest queued item to keep recent messages prioritized.
      const dropped = queue.shift();
      if (dropped) {
        inflight.delete(dropped.key);
        dropped.resolve(dropped.text);
      }
    }
    const p = new Promise((resolve) => {
      queue.push({ text, sourceLang, targetLang, key, resolve });
      processQueue();
    });
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
    return p;
  }

  function processQueue() {
    while (queue.length && active < MAX_CONC) {
      const item = queue.shift();
      active++;
      (async () => {
        try {
          const res = await googleTranslate(item.text, item.sourceLang, item.targetLang);
          cache.set(item.key, res);
          if (cache.size > MAX_CACHE) {
            const first = cache.keys().next().value;
            cache.delete(first);
          }
          inflight.delete(item.key);
          item.resolve(res);
          // success: ease delay down
          delay = Math.max(MIN_DELAY, delay - 5);
        } catch (e) {
          console.warn('[TwitchTranslator] translate error', e);
          inflight.delete(item.key);
          item.resolve(item.text);
          // failure: back off
          delay = Math.min(MAX_DELAY, delay + 120);
        } finally {
          setTimeout(() => {
            active = Math.max(0, active - 1);
            processQueue();
          }, delay);
        }
      })();
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    .tt-translated { color: #9147ff !important; font-size: 11px !important; margin-top: 2px !important; opacity: 0.95 !important; display: block !important; word-break: break-word; }
    .tt-btn { position: fixed; bottom: 16px; right: 16px; z-index: 999999; background: #9147ff; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .tt-btn:hover { background: #772ce8; }
    .tt-nav-btn { background: #9147ff; color: #fff; border: none; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; font-weight: 600; line-height: 1; }
    .tt-nav-btn:hover { background: #772ce8; }
    .tt-nav-btn.tt-nav-tr { background: #1f6feb; }
    .tt-nav-btn.tt-nav-tr:hover { background: #1158c7; }
    .tt-panel { position: fixed; top: 56px; right: 16px; z-index: 1000000; width: 360px; max-width: 92vw; background: #121216; color: #efeff1; border: 1px solid #2f2f35; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.6); font-family: system-ui, sans-serif; font-size: 13px; overflow: hidden; }
    .tt-panel header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #2f2f35; font-weight: 600; font-size: 14px; }
    .tt-panel header button { background: transparent; color: #adadb8; border: none; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; border-radius: 4px; }
    .tt-panel header button:hover { color: #fff; background: #2f2f35; }
    .tt-panel .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .tt-panel textarea { width: 100%; box-sizing: border-box; background: #0e0e10; color: #efeff1; border: 1px solid #2f2f35; border-radius: 8px; padding: 10px; resize: vertical; min-height: 72px; font-family: inherit; font-size: 13px; transition: border-color .15s; }
    .tt-panel textarea:focus { outline: none; border-color: #9147ff; }
    .tt-panel .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .tt-panel select { background: #0e0e10; color: #efeff1; border: 1px solid #2f2f35; border-radius: 8px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
    .tt-panel select:focus { outline: none; border-color: #9147ff; }
    .tt-panel button.action { background: #9147ff; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background .15s; }
    .tt-panel button.action:hover { background: #772ce8; }
    .tt-panel button.action:disabled { opacity: .6; cursor: default; }
    .tt-panel button.secondary { background: #2f2f35; color: #efeff1; }
    .tt-panel button.secondary:hover { background: #3a3a3d; }
    .tt-panel .out { min-height: 52px; white-space: pre-wrap; background: #0e0e10; border: 1px solid #2f2f35; border-radius: 8px; padding: 10px; word-break: break-word; font-size: 13px; }
    .tt-panel .status { font-size: 11px; color: #adadb8; min-height: 14px; }
    .tt-panel details { border-top: 1px solid #2f2f35; padding-top: 8px; }
    .tt-panel details summary { cursor: pointer; color: #adadb8; font-size: 12px; user-select: none; }
    .tt-panel details summary:hover { color: #fff; }
    .tt-panel details .settings { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .tt-panel label { font-size: 12px; color: #adadb8; display: flex; align-items: center; gap: 6px; }
  `;
  document.head.appendChild(style);

  let enabled = settings.enabled;
  let toggleBtn = null;
  let trBtn = null;

  function updateToggleLabel() {
    if (toggleBtn) toggleBtn.textContent = enabled ? 'TT: ON' : 'TT: OFF';
  }

  function makeNavButton(label, title, onClick) {
    const b = document.createElement('button');
    b.className = 'tt-nav-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function injectNavButtons() {
    // Already injected?
    if (document.querySelector('.tt-nav-group')) {
      // refresh refs if needed
      if (!toggleBtn) toggleBtn = document.querySelector('.tt-nav-toggle');
      if (!trBtn) trBtn = document.querySelector('.tt-nav-tr');
      return true;
    }
    const sc = document.querySelector('.top-nav__search-container');
    if (!sc || !sc.parentElement) {
      // fallback: fixed buttons (dashboard or pages without top nav search)
      ensureFixedButtons();
      return false;
    }
    const group = document.createElement('div');
    group.className = 'tt-nav-group';
    group.style.display = 'inline-flex';
    group.style.alignItems = 'center';
    group.style.gap = '6px';
    group.style.marginLeft = '10px';
    group.style.verticalAlign = 'middle';

    toggleBtn = makeNavButton(enabled ? 'TT: ON' : 'TT: OFF', 'Toggle incoming chat translation', () => {
      enabled = !enabled;
      settings.enabled = enabled;
      saveSettings(settings);
      updateToggleLabel();
    });
    toggleBtn.classList.add('tt-nav-toggle');

    trBtn = makeNavButton('TR', 'Open translator panel', togglePanel);
    trBtn.classList.add('tt-nav-tr');

    group.appendChild(toggleBtn);
    group.appendChild(trBtn);
    sc.insertAdjacentElement('afterend', group);
    removeFixedButtons();
    return true;
  }

  // Fallback fixed buttons (only used if top nav search not present)
  let fixedWrap = null;
  function ensureFixedButtons() {
    if (fixedWrap || document.querySelector('.tt-nav-group')) return;
    fixedWrap = document.createElement('div');
    fixedWrap.style.position = 'fixed';
    fixedWrap.style.top = '10px';
    fixedWrap.style.right = '16px';
    fixedWrap.style.zIndex = '999999';
    fixedWrap.style.display = 'flex';
    fixedWrap.style.gap = '6px';
    toggleBtn = makeNavButton(enabled ? 'TT: ON' : 'TT: OFF', 'Toggle incoming chat translation', () => {
      enabled = !enabled;
      settings.enabled = enabled;
      saveSettings(settings);
      updateToggleLabel();
    });
    toggleBtn.classList.add('tt-nav-toggle');
    trBtn = makeNavButton('TR', 'Open translator panel', togglePanel);
    trBtn.classList.add('tt-nav-tr');
    fixedWrap.appendChild(toggleBtn);
    fixedWrap.appendChild(trBtn);
    document.body.appendChild(fixedWrap);
  }
  function removeFixedButtons() {
    if (fixedWrap) { fixedWrap.remove(); fixedWrap = null; }
  }

  // ---------- panel ----------
  function makeSelect(value) {
    const sel = document.createElement('select');
    LANGS.forEach(([code, name]) => {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      if (code === value) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }

  const panel = document.createElement('div');
  panel.className = 'tt-panel';
  panel.style.display = settings.panelOpen ? 'block' : 'none';

  const header = document.createElement('header');
  const title = document.createElement('span');
  title.textContent = 'Translator';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u00d7';
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'body';

  const input = document.createElement('textarea');
  input.rows = 3;
  input.placeholder = 'Type here (any language)...';
  body.appendChild(input);

  const row1 = document.createElement('div');
  row1.className = 'row';
  const tgtSel = makeSelect(settings.outgoingLang);
  // Target language cannot be "auto"
  Array.from(tgtSel.options).forEach(o => { if (o.value === 'auto') o.remove(); });
  const goBtn = document.createElement('button');
  goBtn.className = 'action';
  goBtn.textContent = 'Translate';
  row1.appendChild(tgtSel);
  row1.appendChild(goBtn);
  body.appendChild(row1);

  const out = document.createElement('div');
  out.className = 'out';
  out.textContent = '';
  body.appendChild(out);

  const row2 = document.createElement('div');
  row2.className = 'row';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'action secondary';
  copyBtn.textContent = 'Copy';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'action secondary';
  clearBtn.textContent = 'Clear';
  row2.appendChild(copyBtn);
  row2.appendChild(clearBtn);
  body.appendChild(row2);

  // Advanced settings (collapsible)
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Settings';
  details.appendChild(summary);
  const settingsBox = document.createElement('div');
  settingsBox.className = 'settings';
  const srcLabel = document.createElement('label');
  srcLabel.textContent = 'From';
  const srcSel = makeSelect(settings.sourceLang);
  srcLabel.appendChild(srcSel);
  const incLabel = document.createElement('label');
  incLabel.textContent = 'Incoming \u2192 ';
  const incSel = makeSelect(settings.incomingLang);
  Array.from(incSel.options).forEach(o => { if (o.value === 'auto') o.remove(); });
  incLabel.appendChild(incSel);
  const detectLabel = document.createElement('label');
  const detectChk = document.createElement('input');
  detectChk.type = 'checkbox';
  detectChk.checked = !!settings.autoDetectStream;
  detectLabel.appendChild(detectChk);
  detectLabel.appendChild(document.createTextNode(' Auto-detect stream language'));
  settingsBox.appendChild(srcLabel);
  settingsBox.appendChild(incLabel);
  settingsBox.appendChild(detectLabel);
  details.appendChild(settingsBox);
  body.appendChild(details);

  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = '';
  body.appendChild(status);

  panel.appendChild(body);
  document.body.appendChild(panel);

  function togglePanel() {
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    settings.panelOpen = show;
    saveSettings(settings);
  }
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; settings.panelOpen = false; saveSettings(settings); });

  async function runTranslate() {
    const text = input.value.trim();
    if (!text) { status.textContent = 'Type something first.'; return; }
    const sl = srcSel.value;
    const tl = tgtSel.value;
    if (tl === 'auto') { status.textContent = 'Pick a target language.'; return; }
    status.textContent = 'Translating...';
    goBtn.disabled = true;
    try {
      const res = await doTranslate(text, tl, sl);
      out.textContent = res;
      status.textContent = 'Done.';
      settings.sourceLang = sl;
      settings.outgoingLang = tl;
      saveSettings(settings);
    } catch (e) {
      out.textContent = text;
      status.textContent = 'Error: ' + e;
    } finally {
      goBtn.disabled = false;
    }
  }
  goBtn.addEventListener('click', runTranslate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runTranslate(); }
  });

  copyBtn.addEventListener('click', () => {
    const t = out.textContent || '';
    try { GM_setClipboard(t, 'text'); } catch (e) { navigator.clipboard && navigator.clipboard.writeText(t); }
    status.textContent = 'Copied.';
  });

  clearBtn.addEventListener('click', () => { input.value = ''; out.textContent = ''; status.textContent = ''; });


  detectChk.addEventListener('change', () => {
    settings.autoDetectStream = detectChk.checked;
    saveSettings(settings);
  });
  incSel.addEventListener('change', () => {
    settings.incomingLang = incSel.value;
    saveSettings(settings);
  });
  tgtSel.addEventListener('change', () => {
    settings.outgoingLang = tgtSel.value;
    saveSettings(settings);
  });
  srcSel.addEventListener('change', () => {
    settings.sourceLang = srcSel.value;
    saveSettings(settings);
  });


  // ---------- stream language detection ----------
  let streamLangDetected = false;
  function detectLanguage(text) {
    return new Promise((resolve) => {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&dt=ld&q=' + encodeURIComponent(text);
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 12000,
        onload: (r) => {
          try {
            const data = JSON.parse(r.responseText);
            const lang = data[2] || data[8] || null;
            resolve(lang);
          } catch (e) { resolve(null); }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // ---------- incoming chat translation ----------
  const originals = new WeakSet();

  const chatLineSelector = '[data-a-target="chat-line-message-body"], .seventv-chat-message-body, .video-chat__message';
  const containerSelector = '[data-test-selector="chat-scrollable-area__message-container"], .scrollable-container.seventv-chat-scroller, .video-chat__message-list-wrapper';

  const chatObserver = new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        let lines = [];
        if (node.matches && node.matches(chatLineSelector)) lines = [node];
        else if (node.querySelectorAll) lines = Array.from(node.querySelectorAll(chatLineSelector));
        lines.forEach(handleChatLine);
      }
    }
  });

  function extractText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function handleChatLine(el) {
    if (!el || originals.has(el)) return;
    originals.add(el);
    const text = extractText(el);
    if (!text || text.length < 2) return;
    // Auto-detect stream language once from the first chat message.
    if (!streamLangDetected && settings.autoDetectStream) {
      streamLangDetected = true;
      detectLanguage(text).then((lang) => {
        if (!lang || lang === 'auto') return;
        settings.outgoingLang = lang;
        saveSettings(settings);
        try { if (tgtSel) tgtSel.value = lang; } catch (e) {}
        try { status.textContent = 'Stream language detected: ' + lang; } catch (e) {}
      }).catch(() => {});
    }
    const target = settings.incomingLang || 'en';
    doTranslate(text, target, 'auto', true).then(t => {
      if (!t || t.toLowerCase() === text.toLowerCase()) return;
      if (el.querySelector('.tt-translated')) return;
      const span = document.createElement('span');
      span.className = 'tt-translated';
      span.textContent = target.toUpperCase() + ': ' + t;
      el.appendChild(span);
    }).catch(() => {});
  }

  function attachChatObserver() {
    const container = document.querySelector(containerSelector.split(',')[0].trim())
      || document.querySelector('.scrollable-container.seventv-chat-scroller')
      || document.querySelector('.video-chat__message-list-wrapper');
    if (container && !container._ttObserved) {
      container._ttObserved = true;
      chatObserver.observe(container, { childList: true, subtree: true });
      container.querySelectorAll(chatLineSelector).forEach(handleChatLine);
      console.log('[TwitchTranslator] attached to chat container, lines:', container.querySelectorAll(chatLineSelector).length);
    }
  }

  function init() {
    setInterval(attachChatObserver, 1500);
    setInterval(injectNavButtons, 1500);
    attachChatObserver();
    injectNavButtons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  try {
    GM_registerMenuCommand('Toggle chat translation', () => {
      enabled = !enabled;
      settings.enabled = enabled;
      saveSettings(settings);
      updateToggleLabel();
      alert('Chat translation: ' + (enabled ? 'ON' : 'OFF'));
    });
    GM_registerMenuCommand('Open translator panel', () => {
      panel.style.display = 'block';
      settings.panelOpen = true;
      saveSettings(settings);
    });
    GM_registerMenuCommand('Clear translation cache', () => { cache.clear(); inflight.clear(); alert('Cache cleared'); });
  } catch (e) {}
})();
