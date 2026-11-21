'use strict';
/* ai-bridge ダッシュボード
   パスワードはJS変数にのみ保持し、localStorage等には保存しない。
   Bearerトークンやパスワードの値をこのファイルに書かないこと。 */

const BASES = {
  proxy: 'https://asdfbase3.onrender.com/bridge',
  direct: 'https://api.rds9.net/bridge',
};

const AUTHORS = {
  muse: { label: 'Muse', cls: 'a-muse' },
  pickle: { label: 'Pickle', cls: 'a-pickle' },
  'antigravity-pc': { label: 'AGY・PC', cls: 'a-antigravity-pc' },
  'antigravity-vps': { label: 'AGY・VPS', cls: 'a-antigravity-vps' },
  antigravity: { label: 'Antigravity', cls: 'a-antigravity' },
  yuto: { label: 'yuto', cls: 'a-yuto' },
};
const AUTHOR_ORDER = ['muse', 'pickle', 'antigravity-pc', 'antigravity-vps', 'antigravity', 'yuto'];

const KINDS = {
  note: { label: 'メモ', cls: 'k-note' },
  decision: { label: '決定', cls: 'k-decision' },
  action: { label: '実行', cls: 'k-action' },
  alert: { label: '注意', cls: 'k-alert' },
};
const KIND_ORDER = ['note', 'decision', 'action', 'alert'];

const STATUS_TEXT = { live: '接続中', reconnecting: '再接続中', disconnected: '切断' };

const state = {
  password: '',          // JS変数のみ。永続保存しない
  mode: 'proxy',         // 'proxy' | 'direct'
  transport: 'sse',      // 'sse' | 'ws'
  loggedIn: false,
  notes: [],
  noteIds: new Set(),
  authorFilter: 'all',
  kindFilter: 'all',
  status: 'disconnected', // 'live' | 'reconnecting' | 'disconnected'
  sseAbort: null,
  ws: null,
  reconnectTimer: null,
  backoffMs: 1000,       // 再接続の待ち時間（指数バックオフ、最大30秒）
  streamGeneration: 0,   // 古い再接続・ストリームを無効化するための世代カウンタ
  loadGeneration: 0,     // 古いメモ読み込みの結果を捨てるための世代カウンタ
  stickToBottom: true,   // フィードの一番下にいるかどうか
};

/* ---------- DOM ---------- */
const $ = (sel) => document.querySelector(sel);
const loginScreen = $('#login-screen');
const board = $('#board');
const loginForm = $('#login-form');
const passwordInput = $('#password-input');
const loginBtn = $('#login-btn');
const loginError = $('#login-error');
const feed = $('#feed');
const jumpBtn = $('#jump-btn');
const statusPill = $('#status-pill');
const statusText = $('#status-text');
const authorFilters = $('#author-filters');
const kindFilters = $('#kind-filters');
const kindSelect = $('#kind-select');
const mentionSelect = $('#mention-select');
const composerInput = $('#composer-input');
const postBtn = $('#post-btn');
const composerError = $('#composer-error');

/* ---------- 小物 ---------- */
function base() { return BASES[state.mode]; }
function authHeaders() { return { 'X-Bridge-Password': state.password }; }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// URLをリンク化する（エスケープ済みテキストに対して行う）
function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const href = m.replace(/&amp;/g, '&');
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + m + '</a>';
  });
}
function renderText(text) { return linkify(escapeHtml(text)); }

// JSTで「M/D HH:MM」形式にする
const dtf = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function formatTs(ts) {
  if (ts == null) return '';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return dtf.format(d);
}

function authorInfo(key) {
  return AUTHORS[key] || { label: key, cls: '' };
}
function kindInfo(key) {
  return KINDS[key] || KINDS.note;
}

/* ---------- 接続状態 ---------- */
function setStatus(s) {
  state.status = s;
  statusPill.dataset.status = s;
  statusText.textContent = STATUS_TEXT[s] || '切断';
}

/* ---------- フィード ---------- */
function isNearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function scrollToBottom() { feed.scrollTop = feed.scrollHeight; }

function showFeedMessage(text) {
  feed.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'feed-message';
  p.textContent = text;
  feed.appendChild(p);
}

function createNoteEl(note) {
  const el = document.createElement('article');
  el.className = 'note' + (note.mention ? ' note-mentioned' : '');
  el.dataset.id = String(note.id);
  const a = authorInfo(note.author);
  const k = kindInfo(note.kind || 'note');
  // メンションがあるメモは宛先を目立たせて表示する（告知は大事なので目立つ色に）。
  const mentionHtml = note.mention
    ? '<span class="mention-chip">→ @' + escapeHtml(authorInfo(note.mention).label) + '</span>'
    : '';
  el.innerHTML =
    '<div class="note-head">' +
      '<span class="author-badge ' + a.cls + '"><span class="dot"></span>' + escapeHtml(a.label) + '</span>' +
      mentionHtml +
      '<span class="kind-badge ' + k.cls + '">' + escapeHtml(k.label) + '</span>' +
      '<span class="note-time">' + escapeHtml(formatTs(note.ts)) + '</span>' +
    '</div>' +
    '<div class="note-text">' + renderText(note.text || '') + '</div>';
  return el;
}

function notePassesFilter(n) {
  if (state.authorFilter !== 'all' && n.author !== state.authorFilter) return false;
  if (state.kindFilter !== 'all' && (n.kind || 'note') !== state.kindFilter) return false;
  return true;
}

// フィード全体を描き直す（初期読み込み・フィルタ変更時）
function renderAll() {
  feed.innerHTML = '';
  const list = state.notes.filter(notePassesFilter);
  if (list.length === 0) {
    showFeedMessage(state.notes.length === 0 ? 'まだメモがありません。' : 'フィルタに一致するメモがありません。');
    jumpBtn.hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const n of list) frag.appendChild(createNoteEl(n));
  feed.appendChild(frag);
  scrollToBottom();
  jumpBtn.hidden = true;
}

// ライブで届いたメモを1件追加する（重複は無視）
function addNote(note) {
  if (!note || note.id == null || typeof note.text !== 'string') return false;
  if (state.noteIds.has(note.id)) return false;
  state.noteIds.add(note.id);
  state.notes.push(note);
  const msg = feed.querySelector('.feed-message');
  if (msg) msg.remove();
  if (!notePassesFilter(note)) return true;
  feed.appendChild(createNoteEl(note));
  if (state.stickToBottom) {
    scrollToBottom();
  } else {
    jumpBtn.hidden = false;
  }
  return true;
}

/* ---------- フィルタ ---------- */
function chipButton(label, active) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (active ? ' active' : '');
  b.textContent = label;
  return b;
}
function buildFilters() {
  authorFilters.innerHTML = '';
  const allA = chipButton('すべて', state.authorFilter === 'all');
  allA.addEventListener('click', () => setAuthorFilter('all'));
  authorFilters.appendChild(allA);
  for (const key of AUTHOR_ORDER) {
    const b = chipButton(AUTHORS[key].label, state.authorFilter === key);
    b.dataset.author = key;
    b.addEventListener('click', () => setAuthorFilter(key));
    authorFilters.appendChild(b);
  }
  kindFilters.innerHTML = '';
  const allK = chipButton('すべて', state.kindFilter === 'all');
  allK.addEventListener('click', () => setKindFilter('all'));
  kindFilters.appendChild(allK);
  for (const key of KIND_ORDER) {
    const b = chipButton(KINDS[key].label, state.kindFilter === key);
    b.dataset.kind = key;
    b.addEventListener('click', () => setKindFilter(key));
    kindFilters.appendChild(b);
  }
}
function syncFilterButtons() {
  authorFilters.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b.dataset.author || 'all') === state.authorFilter);
  });
  kindFilters.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b.dataset.kind || 'all') === state.kindFilter);
  });
}
function setAuthorFilter(v) { state.authorFilter = v; syncFilterButtons(); renderAll(); }
function setKindFilter(v) { state.kindFilter = v; syncFilterButtons(); renderAll(); }

/* ---------- ログイン ---------- */
function showLoginError(msg) { loginError.textContent = msg; loginError.hidden = false; }
function hideLoginError() { loginError.hidden = true; loginError.textContent = ''; }
function showComposerError(msg) { composerError.textContent = msg; composerError.hidden = false; }
function hideComposerError() { composerError.hidden = true; composerError.textContent = ''; }

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pw = passwordInput.value;
  if (!pw) { showLoginError('パスワードを入力してください。'); return; }
  loginBtn.disabled = true;
  loginBtn.textContent = '確認中…';
  hideLoginError();
  try {
    const res = await fetch(BASES[state.mode] + '/notes?limit=1', {
      headers: { 'X-Bridge-Password': pw },
    });
    if (res.status === 401) {
      showLoginError('パスワードが違います。');
      return;
    }
    if (!res.ok) {
      showLoginError('接続できませんでした（' + res.status + '）。しばらくしてからもう一度お試しください。');
      return;
    }
    // ログイン成功。パスワードはJS変数にだけ保持する
    state.password = pw;
    passwordInput.value = '';
    state.loggedIn = true;
    loginScreen.hidden = true;
    board.hidden = false;
    await loadNotes();
    startStream();
  } catch (e) {
    showLoginError('接続できませんでした。ネットワークを確認して、もう一度お試しください。');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '開く';
  }
});

// パスワードが無効になった場合：ログイン画面に戻す
function authFailed() {
  stopStream();
  state.password = '';
  state.loggedIn = false;
  state.notes = [];
  state.noteIds.clear();
  board.hidden = true;
  loginScreen.hidden = false;
  setStatus('disconnected');
  showLoginError('パスワードが無効です。もう一度ログインしてください。');
}

/* ---------- メモの読み込み ---------- */
async function loadNotes() {
  const myLoad = ++state.loadGeneration;
  showFeedMessage('読み込み中…');
  try {
    const res = await fetch(base() + '/notes?since=0&limit=50', { headers: authHeaders() });
    if (myLoad !== state.loadGeneration) return; // 新しい読み込みが始まったので結果を捨てる
    if (res.status === 401) { authFailed(); return; }
    if (!res.ok) throw new Error('notes failed: ' + res.status);
    const data = await res.json();
    if (myLoad !== state.loadGeneration) return;
    const fetched = Array.isArray(data.notes) ? data.notes : [];
    const fetchedIds = new Set();
    const clean = [];
    for (const n of fetched) {
      if (n && n.id != null && !fetchedIds.has(n.id)) {
        fetchedIds.add(n.id);
        clean.push(n);
      }
    }
    // 読み込み中にライブで届いたメモは残す
    const keep = state.notes.filter((n) => !fetchedIds.has(n.id));
    state.notes = clean.concat(keep);
    state.notes.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    state.noteIds = new Set(state.notes.map((n) => n.id));
    renderAll();
  } catch (e) {
    if (myLoad !== state.loadGeneration) return;
    showFeedMessage('メモの読み込みに失敗しました。');
  }
}

/* ---------- ライブストリーム ---------- */
function startStream() {
  stopStreamInternal();
  const gen = ++state.streamGeneration;
  setStatus('reconnecting');
  if (state.transport === 'ws') connectWS(gen);
  else connectSSE(gen);
}
function stopStream() {
  state.streamGeneration++;
  stopStreamInternal();
  setStatus('disconnected');
}
function stopStreamInternal() {
  if (state.sseAbort) { try { state.sseAbort.abort(); } catch (e) {} state.sseAbort = null; }
  if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}
function scheduleReconnect() {
  setStatus('reconnecting');
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, 30000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.loggedIn) return;
    startStream();
  }, delay);
}

/* SSE：fetch + ReadableStreamで読む（ヘッダーを送るためEventSourceは使わない） */
async function connectSSE(gen) {
  const ctrl = new AbortController();
  state.sseAbort = ctrl;
  let res;
  try {
    res = await fetch(base() + '/stream', {
      headers: { 'Accept': 'text/event-stream', 'X-Bridge-Password': state.password },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (gen !== state.streamGeneration || ctrl.signal.aborted) return;
    scheduleReconnect();
    return;
  }
  if (gen !== state.streamGeneration) return;
  if (res.status === 401) { authFailed(); return; }
  if (!res.ok || !res.body) { scheduleReconnect(); return; }
  setStatus('live');
  state.backoffMs = 1000;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (gen !== state.streamGeneration) { try { await reader.cancel(); } catch (e) {} return; }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleSSEEvent(raw);
      }
    }
  } catch (e) {
    // 読み取りエラー → 再接続へ
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  if (gen !== state.streamGeneration) return;
  scheduleReconnect();
}

// SSEの1イベントを処理する。`: ping` のようなコメント行は無視する
function handleSSEEvent(raw) {
  const lines = raw.split('\n');
  let data = '';
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
  }
  data = data.replace(/\n$/, '');
  if (!data) return;
  try {
    addNote(JSON.parse(data));
  } catch (e) {
    // JSONでない行は無視
  }
}

/* WebSocket：毎回 ws-token を取り直して接続する（トークンは短命・使い切り） */
async function connectWS(gen) {
  let token = '';
  try {
    const res = await fetch(base() + '/ws-token', {
      method: 'POST',
      headers: authHeaders(),
    });
    if (gen !== state.streamGeneration) return;
    if (res.status === 401) { authFailed(); return; }
    if (!res.ok) throw new Error('ws-token failed: ' + res.status);
    const data = await res.json();
    token = data && data.token ? data.token : '';
  } catch (e) {
    if (gen !== state.streamGeneration) return;
    scheduleReconnect();
    return;
  }
  if (!token) { scheduleReconnect(); return; }
  const wsUrl = base().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  ws.onopen = () => {
    if (gen !== state.streamGeneration) { try { ws.close(); } catch (e) {} return; }
    setStatus('live');
    state.backoffMs = 1000;
  };
  ws.onmessage = (ev) => {
    if (gen !== state.streamGeneration) return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg && msg.type === 'hello') return;
      addNote(msg);
    } catch (e) {
      // JSONでないメッセージは無視
    }
  };
  ws.onclose = () => {
    if (gen !== state.streamGeneration) return;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose が続いて呼ばれるのでここでは何もしない
  };
}

/* ---------- 接続モード / 通信方式の切り替え ---------- */
function setMode(mode) {
  if (!BASES[mode] || state.mode === mode) return;
  state.mode = mode;
  syncToggleButtons();
  if (!state.loggedIn) return;
  // ベースURLが変わるのでメモを読み直してストリームを繋ぎ直す
  state.notes = [];
  state.noteIds.clear();
  renderAll();
  loadNotes();
  startStream();
}
function setTransport(t) {
  if ((t !== 'sse' && t !== 'ws') || state.transport === t) return;
  state.transport = t;
  syncToggleButtons();
  if (!state.loggedIn) return;
  startStream();
}
function syncToggleButtons() {
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });
  document.querySelectorAll('[data-transport]').forEach((b) => {
    b.classList.toggle('active', b.dataset.transport === state.transport);
  });
}

/* ---------- 投稿 ---------- */
async function postNote() {
  const text = composerInput.value.trim();
  if (!text) return;
  const kind = kindSelect.value;
  const mention = mentionSelect.value || null;
  postBtn.disabled = true;
  hideComposerError();
  try {
    const res = await fetch(base() + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Password': state.password },
      body: JSON.stringify({ author: 'yuto', text, kind, mention, priority: 'normal' }),
    });
    if (res.status === 401) {
      showComposerError('パスワードが無効です。ページを再読み込みしてログインし直してください。');
      return;
    }
    if (!res.ok) {
      showComposerError('送信に失敗しました（' + res.status + '）。しばらくしてからもう一度お試しください。');
      return;
    }
    const created = await res.json().catch(() => null);
    const noteObj = created && created.id != null
      ? created
      : (created && created.note && created.note.id != null ? created.note : null);
    composerInput.value = '';
    mentionSelect.value = '';
    if (noteObj) addNote(noteObj); // ストリーム経由でも届くが、重複はaddNoteが弾く
  } catch (e) {
    showComposerError('送信に失敗しました。ネットワークを確認してください。');
  } finally {
    postBtn.disabled = false;
    composerInput.focus();
  }
}

/* ---------- 配線 ---------- */
function init() {
  buildFilters();
  syncToggleButtons();
  setStatus('disconnected');

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  document.querySelectorAll('[data-transport]').forEach((b) => {
    b.addEventListener('click', () => setTransport(b.dataset.transport));
  });

  feed.addEventListener('scroll', () => {
    state.stickToBottom = isNearBottom();
    if (state.stickToBottom) jumpBtn.hidden = true;
  });
  jumpBtn.addEventListener('click', () => {
    scrollToBottom();
    jumpBtn.hidden = true;
    state.stickToBottom = true;
  });

  postBtn.addEventListener('click', postNote);
  composerInput.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      postNote();
    }
  });
}
init();
