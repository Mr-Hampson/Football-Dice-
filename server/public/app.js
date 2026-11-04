// Teacher dashboard. Plain JavaScript, no framework, so it is easy to read
// and change. The server pushes a full "lesson state" over a WebSocket
// whenever anything changes, and this file simply redraws from it.

const $ = (id) => document.getElementById(id);

// Sites a teacher can tick when starting a lesson. Each preset is a set of
// domains (sites like Google Classroom need several to work).
const PRESETS = [
  { label: 'BBC Bitesize', domains: ['bbc.co.uk', 'bbci.co.uk'] },
  { label: 'Google Classroom', domains: ['classroom.google.com', 'docs.google.com', 'drive.google.com', 'accounts.google.com'] },
  { label: 'Microsoft 365', domains: ['office.com', 'microsoft365.com', 'sharepoint.com', 'login.microsoftonline.com'] },
  { label: 'Google Search', domains: ['google.com', 'google.co.uk'] },
  { label: 'YouTube', domains: ['youtube.com'] },
];

const STATUS_TEXT = {
  on: 'On task',
  off: 'Off task',
  idle: 'Home screen',
  unknown: "Can't tell",
  asleep: 'Screen off',
  offline: 'Not connected',
};
const SUMMARY_ORDER = ['on', 'off', 'idle', 'unknown', 'asleep', 'offline'];

const state = {
  view: 'lesson',
  lessonId: null,
  snap: null, // latest lessonState from the server
  selected: new Set(),
  startDomains: [],
  ws: null,
  wsRetry: 1000,
};

// ---- Small helpers ---------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function normaliseDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s) ? s : null;
}

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(`hub.${key}`);
    else localStorage.setItem(`hub.${key}`, value);
  } catch { /* private mode etc. */ }
}
function recall(key) {
  try { return localStorage.getItem(`hub.${key}`); } catch { return null; }
}

// ---- Views -----------------------------------------------------------------

function showOnly(id) {
  for (const v of ['loginView', 'lessonView', 'tabletsView']) $(v).hidden = v !== id;
}

function showLogin() {
  $('topbarControls').hidden = true;
  showOnly('loginView');
  $('password').focus();
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

function setView(view) {
  state.view = view;
  $('navLesson').classList.toggle('active', view === 'lesson');
  $('navTablets').classList.toggle('active', view === 'tablets');
  showOnly(view === 'lesson' ? 'lessonView' : 'tabletsView');
  if (view === 'tablets') loadTablets();
  render();
}

// ---- Live connection -------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/teacher`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 1000;
    watch(state.lessonId);
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== 'lessonState' || msg.lessonId !== state.lessonId) return;
    if (msg.ended) {
      // Our lesson finished (ended elsewhere or hit the time limit).
      state.lessonId = null;
      store('lessonId', null);
      msg.lessonId = null;
    }
    state.snap = msg;
    // Forget selections of pupils who have left.
    const ids = new Set((msg.pupils || []).map((p) => p.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    render();
  };
  ws.onclose = () => {
    // Reconnect automatically, waiting a little longer each time.
    setTimeout(async () => {
      const { teacher } = await fetch('/api/me').then((r) => r.json()).catch(() => ({ teacher: true }));
      if (teacher) connect();
      else showLogin();
    }, state.wsRetry);
    state.wsRetry = Math.min(state.wsRetry * 2, 15000);
  };
}

function watch(lessonId) {
  if (lessonId !== state.lessonId) {
    state.selected.clear();
    state.snap = null;
  }
  state.lessonId = lessonId;
  store('lessonId', lessonId);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'watch', lessonId }));
  }
  render();
}

// ---- Lesson view rendering -------------------------------------------------

function render() {
  if (state.view !== 'lesson') return;
  const snap = state.snap;
  const lesson = snap && snap.lesson;
  $('startPanel').hidden = !snap || !!lesson;
  $('runningPanel').hidden = !lesson;
  $('selectionHint').hidden = !lesson || !snap.pupils.length;
  if (snap && !lesson) renderStartPanel(snap);
  if (lesson) renderRunning(snap);
  renderGrid(snap);
  renderUnjoined(snap);
}

function renderStartPanel(snap) {
  const list = $('presetList');
  if (!list.childElementCount) {
    for (const preset of PRESETS) {
      const box = el('input', { type: 'checkbox', onchange: () => togglePreset(preset, box.checked) });
      list.append(el('label', { class: 'preset' }, box, preset.label));
    }
  }
  $('startChips').replaceChildren(...state.startDomains.map((d) => chip(d, () => {
    state.startDomains = state.startDomains.filter((x) => x !== d);
    render();
  })));
  $('runningList').hidden = !snap.lessons.length;
  $('runningButtons').replaceChildren(...snap.lessons.map((l) =>
    el('button', { type: 'button', onclick: () => watch(l.id) }, `${l.title} · ${l.joinCode} · ${l.pupilCount} pupils`)));
}

function chip(text, onRemove) {
  return el('span', { class: 'chip' }, text,
    el('button', { type: 'button', 'aria-label': `Remove ${text}`, onclick: onRemove }, '×'));
}

function togglePreset(preset, on) {
  if (on) {
    for (const d of preset.domains) if (!state.startDomains.includes(d)) state.startDomains.push(d);
  } else {
    state.startDomains = state.startDomains.filter((d) => !preset.domains.includes(d));
  }
  render();
}

function renderRunning(snap) {
  const { lesson, pupils } = snap;
  $('joinCode').textContent = lesson.joinCode;
  $('lessonTitleShown').textContent = lesson.title;
  $('lessonTimes').textContent = `Started ${clock(lesson.startedAt)} · ends automatically at ${clock(lesson.endsAt)}`;

  const counts = {};
  for (const p of pupils) counts[p.status] = (counts[p.status] || 0) + 1;
  $('summary').replaceChildren(
    el('span', { class: 'count s-connected' }, `${pupils.length} joined`),
    ...SUMMARY_ORDER.filter((s) => counts[s]).map((s) =>
      el('span', { class: `count s-${s}` }, `${counts[s]} ${STATUS_TEXT[s].toLowerCase()}`)),
  );

  $('allowedChips').replaceChildren(
    ...lesson.allowedDomains.map((d) => chip(d, () => updateAllowed(lesson.allowedDomains.filter((x) => x !== d)))),
    ...lesson.allowedApps.map((pkg) => chip(`app: ${pkg}`, () => updateAllowed(undefined, lesson.allowedApps.filter((x) => x !== pkg)))),
    ...(lesson.allowedDomains.length || lesson.allowedApps.length ? [] : [el('span', { class: 'hint' }, 'none yet')]),
  );

  const n = state.selected.size;
  $('sendSelectedBtn').disabled = n === 0;
  $('sendSelectedBtn').textContent = `Send to selected (${n})`;
  $('actionBar').hidden = n === 0;
  $('selectedCount').textContent = `${n} selected:`;
}

function cardDetail(p) {
  switch (p.status) {
    case 'on': return p.matched ? `${p.appLabel || 'Browser'} · ${p.matched}` : p.appLabel || '';
    case 'off': return p.domain ? `${p.appLabel || 'Browser'} · ${p.domain}` : p.appLabel || 'Another app';
    case 'unknown': return p.detail || 'Waiting for the tablet to report';
    case 'offline': return `Last seen ${ago(p.lastSeen)}`;
    case 'asleep': return 'Tablet asleep or locked';
    case 'idle': return 'Not using an app';
    default: return '';
  }
}

function linkSummary(lesson, p) {
  // Show the most recent link sent to this pupil.
  for (let i = lesson.links.length - 1; i >= 0; i--) {
    const stage = p.links[lesson.links[i].id];
    if (stage) {
      const host = new URL(lesson.links[i].url).hostname.replace(/^www\./, '');
      const text = { sent: '⏳ waiting', delivered: '✓ received', opened: '✓✓ opened' }[stage];
      return `Link (${host}): ${text}`;
    }
  }
  return null;
}

function renderGrid(snap) {
  const grid = $('pupilGrid');
  if (!snap || !snap.lesson) {
    grid.replaceChildren();
    return;
  }
  if (!snap.pupils.length) {
    grid.replaceChildren(el('p', { class: 'panel empty' },
      `No one has joined yet. Ask pupils to open Classroom Hub and type the code ${snap.lesson.joinCode}.`));
    return;
  }
  grid.replaceChildren(...snap.pupils.map((p) => {
    const selected = state.selected.has(p.id);
    const quick = [];
    if (p.status === 'off' && p.domain) {
      quick.push(el('button', { type: 'button', class: 'small quick', onclick: (e) => { e.stopPropagation(); allowDomain(p.domain); } }, `Allow ${p.domain}`));
    }
    if (p.status === 'off' && !p.domain && p.appPackage) {
      quick.push(el('button', { type: 'button', class: 'small quick', onclick: (e) => { e.stopPropagation(); allowApp(p.appPackage); } }, `Allow ${p.appLabel || 'this app'}`));
    }
    const badges = [];
    if (p.duplicateName) badges.push(el('div', { class: 'badge' }, '⚠ Same name as another tablet'));
    if (p.nameRequested) badges.push(el('div', { class: 'badge info' }, '✎ Asked to retype name'));
    if (p.connected && p.perms && (!p.perms.usage || !p.perms.website)) {
      badges.push(el('div', { class: 'detail' }, !p.perms.usage ? '⚠ App tracking permission off' : '⚠ Website check off'));
    }
    return el('div', {
      class: `card s-${p.status}${selected ? ' selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-pressed': selected ? 'true' : 'false',
      onclick: () => toggleSelect(p.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(p.id); } },
    },
    el('span', { class: 'tick', 'aria-hidden': 'true' }),
    el('div', { class: 'name' }, p.name),
    el('div', { class: 'tablet' }, `Tablet ${p.tabletNumber}`),
    el('div', { class: 'status' }, STATUS_TEXT[p.status] || p.status),
    el('div', { class: 'detail' }, cardDetail(p)),
    badges,
    quick,
    el('div', { class: 'linkstate' }, linkSummary(snap.lesson, p)));
  }));
}

function renderUnjoined(snap) {
  const list = snap ? snap.unjoinedTablets : [];
  $('unjoinedPanel').hidden = !list.length;
  $('unjoinedChips').replaceChildren(...list.map((n) => el('span', { class: 'chip' }, `Tablet ${n}`)));
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

// ---- Lesson actions --------------------------------------------------------

function lessonUrl(suffix) {
  return `/api/lessons/${state.lessonId}${suffix}`;
}

async function guarded(fn) {
  $('linkError').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('linkError').textContent = err.message;
  }
}

function updateAllowed(allowedDomains, allowedApps) {
  return guarded(() => api('PUT', lessonUrl('/allowed'), { allowedDomains, allowedApps }));
}

function allowDomain(domain) {
  const current = state.snap.lesson.allowedDomains;
  if (!current.includes(domain)) updateAllowed([...current, domain]);
}

function allowApp(pkg) {
  const current = state.snap.lesson.allowedApps;
  if (!current.includes(pkg)) updateAllowed(undefined, [...current, pkg]);
}

function sendLink(tabletIds) {
  const url = $('linkInput').value.trim();
  if (!url) {
    $('linkError').textContent = 'Paste a link first.';
    return;
  }
  guarded(async () => {
    await api('POST', lessonUrl('/links'), { url, tabletIds });
    $('linkInput').value = '';
    state.selected.clear();
    render();
  });
}

// ---- Tablets view ----------------------------------------------------------

async function loadTablets() {
  const { tablets } = await api('GET', '/api/tablets');
  const rows = tablets.map((t) => el('tr', {},
    el('td', {}, `Tablet ${t.number}`),
    el('td', {}, t.connected ? (t.lessonTitle ? `In lesson: ${t.lessonTitle}` : 'On, not in a lesson') : 'Off / not connected'),
    el('td', {}, t.connected ? 'now' : ago(t.lastSeen)),
    el('td', {}, el('button', { type: 'button', class: 'small danger', onclick: () => removeTablet(t) }, 'Remove'))));
  $('tabletRows').replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { colspan: '4', class: 'hint' }, 'No tablets set up yet.'))]));
}

async function removeTablet(t) {
  if (!confirm(`Remove Tablet ${t.number}? It will need setting up again.`)) return;
  await api('DELETE', `/api/tablets/${t.id}`);
  loadTablets();
}

// ---- Wiring ----------------------------------------------------------------

function wire() {
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      await api('POST', '/api/login', { password: $('password').value });
      $('password').value = '';
      start();
    } catch (err) {
      $('loginError').textContent = err.message;
    }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    showLogin();
  });
  $('navLesson').addEventListener('click', () => setView('lesson'));
  $('navTablets').addEventListener('click', () => setView('tablets'));

  $('startAddCustom').addEventListener('click', () => {
    const d = normaliseDomain($('startCustom').value);
    if (d && !state.startDomains.includes(d)) state.startDomains.push(d);
    $('startCustom').value = '';
    render();
  });
  $('startLessonBtn').addEventListener('click', async () => {
    const { id } = await api('POST', '/api/lessons', { title: $('lessonTitle').value, allowedDomains: state.startDomains });
    $('lessonTitle').value = '';
    watch(id);
  });
  $('endLessonBtn').addEventListener('click', async () => {
    if (!confirm('End the lesson? All tablets leave and names and activity are cleared.')) return;
    await api('POST', lessonUrl('/end'));
  });
  $('linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendLink(null);
  });
  $('sendSelectedBtn').addEventListener('click', () => sendLink([...state.selected]));
  $('allowedForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = normaliseDomain($('allowedInput').value);
    if (d) allowDomain(d);
    $('allowedInput').value = '';
  });
  $('renameBtn').addEventListener('click', () => guarded(async () => {
    await api('POST', lessonUrl('/rename-requests'), { tabletIds: [...state.selected] });
    state.selected.clear();
    render();
  }));
  $('removeBtn').addEventListener('click', () => guarded(async () => {
    if (!confirm(`Remove ${state.selected.size} pupil(s) from the lesson? Their tablets go back to the join screen.`)) return;
    await api('POST', lessonUrl('/remove'), { tabletIds: [...state.selected] });
    state.selected.clear();
    render();
  }));
  $('clearSelBtn').addEventListener('click', () => {
    state.selected.clear();
    render();
  });

  $('setupCodeBtn').addEventListener('click', async () => {
    const { code } = await api('POST', '/api/tablets/setup-code');
    $('codeValue').textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
    $('codeServer').textContent = location.origin;
    $('codeDialog').showModal();
  });

  // Keep "last seen" text fresh, and the tablets list when it is open.
  setInterval(() => {
    render();
    if (state.view === 'tablets') loadTablets().catch(() => {});
  }, 15_000);
}

function start() {
  $('topbarControls').hidden = false;
  state.lessonId = recall('lessonId');
  setView('lesson');
  if (!state.ws) connect();
  else watch(state.lessonId);
}

wire();
fetch('/api/me')
  .then((r) => r.json())
  .then(({ teacher }) => (teacher ? start() : showLogin()))
  .catch(showLogin);
