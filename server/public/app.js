// Teacher dashboard. Plain JavaScript, no framework, so it is easy to read
// and change. The server pushes a full "class state" over a WebSocket
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
  connected: 'Connected',
  unpaired: 'Tablet not set up',
};
const SUMMARY_ORDER = ['on', 'off', 'idle', 'unknown', 'asleep', 'offline', 'unpaired', 'connected'];

const state = {
  view: 'lesson',
  classes: [],
  classId: null,
  classState: null,
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

function normaliseDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s) ? s : null;
}

// ---- Views -----------------------------------------------------------------

function showOnly(id) {
  for (const v of ['loginView', 'lessonView', 'manageView']) $(v).hidden = v !== id;
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
  $('navManage').classList.toggle('active', view === 'manage');
  showOnly(view === 'lesson' ? 'lessonView' : 'manageView');
  render();
  if (view === 'manage') loadManage();
}

async function loadClasses(selectId) {
  const { classes } = await api('GET', '/api/classes');
  state.classes = classes;
  const select = $('classSelect');
  select.replaceChildren(...classes.map((c) => el('option', { value: c.id }, `${c.name} (${c.pupilCount})`)));
  const remembered = selectId || state.classId || localStorageGet('classId');
  state.classId = classes.some((c) => c.id === remembered) ? remembered : classes[0]?.id || null;
  if (state.classId) select.value = state.classId;
  select.hidden = !classes.length;
  watchClass();
}

function localStorageGet(key) {
  try { return localStorage.getItem(`hub.${key}`); } catch { return null; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(`hub.${key}`, value); } catch { /* private mode etc. */ }
}

// ---- Live connection -------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/teacher`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 1000;
    watchClass();
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'classState' && msg.classId === state.classId) {
      state.classState = msg;
      render();
    }
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

function watchClass() {
  state.classState = null;
  state.selected.clear();
  render();
  if (state.ws && state.ws.readyState === WebSocket.OPEN && state.classId) {
    state.ws.send(JSON.stringify({ type: 'watch', classId: state.classId }));
  }
}

// ---- Lesson view rendering -------------------------------------------------

function render() {
  if (state.view !== 'lesson') return;
  const cs = state.classState;
  $('noClasses').hidden = state.classes.length > 0;
  const lesson = cs && cs.lesson;
  $('startPanel').hidden = !cs || !!lesson;
  $('runningPanel').hidden = !lesson;
  $('selectionHint').hidden = !lesson;

  if (cs && !lesson) renderStartPanel();
  if (lesson) renderRunning(cs);
  renderGrid(cs);
}

function renderStartPanel() {
  const list = $('presetList');
  if (!list.childElementCount) {
    for (const preset of PRESETS) {
      const box = el('input', { type: 'checkbox', onchange: () => togglePreset(preset, box.checked) });
      list.append(el('label', { class: 'preset' }, box, preset.label));
    }
  }
  $('startChips').replaceChildren(
    ...state.startDomains.map((d) =>
      el('span', { class: 'chip' }, d, el('button', {
        type: 'button', 'aria-label': `Remove ${d}`,
        onclick: () => { state.startDomains = state.startDomains.filter((x) => x !== d); render(); },
      }, '×'))),
  );
}

function togglePreset(preset, on) {
  if (on) {
    for (const d of preset.domains) if (!state.startDomains.includes(d)) state.startDomains.push(d);
  } else {
    state.startDomains = state.startDomains.filter((d) => !preset.domains.includes(d));
  }
  render();
}

function displayStatus(p) {
  if (!p.paired && !p.connected) return 'unpaired';
  return p.status;
}

function renderRunning(cs) {
  const counts = {};
  for (const p of cs.pupils) {
    const s = displayStatus(p);
    counts[s] = (counts[s] || 0) + 1;
  }
  $('summary').replaceChildren(
    ...SUMMARY_ORDER.filter((s) => counts[s]).map((s) => el('span', { class: `count s-${s}` }, `${counts[s]} ${STATUS_TEXT[s].toLowerCase()}`)),
  );
  $('allowedChips').replaceChildren(
    ...cs.lesson.allowedDomains.map((d) =>
      el('span', { class: 'chip' }, d, el('button', {
        type: 'button', 'aria-label': `Remove ${d}`, onclick: () => updateAllowed(cs.lesson.allowedDomains.filter((x) => x !== d)),
      }, '×'))),
    ...cs.lesson.allowedApps.map((pkg) =>
      el('span', { class: 'chip' }, `app: ${pkg}`, el('button', {
        type: 'button', 'aria-label': `Remove ${pkg}`, onclick: () => updateAllowed(undefined, cs.lesson.allowedApps.filter((x) => x !== pkg)),
      }, '×'))),
    ...(cs.lesson.allowedDomains.length || cs.lesson.allowedApps.length ? [] : [el('span', { class: 'hint' }, 'none yet')]),
  );
  const n = state.selected.size;
  $('sendSelectedBtn').disabled = n === 0;
  $('sendSelectedBtn').textContent = `Send to selected (${n})`;
}

function cardDetail(p) {
  switch (p.status) {
    case 'on': return p.matched ? `${p.appLabel || 'Browser'} · ${p.matched}` : p.appLabel || '';
    case 'off': return p.domain ? `${p.appLabel || 'Browser'} · ${p.domain}` : p.appLabel || 'Another app';
    case 'unknown': return p.detail || 'Waiting for the tablet to report';
    case 'offline': return p.paired ? `Last seen ${ago(p.lastSeen)}` : '';
    case 'asleep': return 'Tablet asleep or locked';
    case 'idle': return 'Not using an app';
    case 'connected': return 'Ready – start a lesson to see activity';
    default: return '';
  }
}

function linkSummary(cs, p) {
  const links = cs.lesson ? cs.lesson.links : [];
  // Show the most recent link sent to this pupil.
  for (let i = links.length - 1; i >= 0; i--) {
    const stage = p.links[links[i].id];
    if (stage) {
      const host = new URL(links[i].url).hostname.replace(/^www\./, '');
      const text = { sent: '⏳ waiting', delivered: '✓ received', opened: '✓✓ opened' }[stage];
      return `Link (${host}): ${text}`;
    }
  }
  return null;
}

function renderGrid(cs) {
  const grid = $('pupilGrid');
  if (!cs) {
    grid.replaceChildren();
    return;
  }
  if (!cs.pupils.length) {
    grid.replaceChildren(el('p', { class: 'panel empty' }, 'No pupils in this class yet. Add them under “Classes & tablets”.'));
    return;
  }
  grid.replaceChildren(...cs.pupils.map((p) => {
    const status = displayStatus(p);
    const selected = state.selected.has(p.id);
    const quick = [];
    if (cs.lesson && p.status === 'off' && p.domain) {
      quick.push(el('button', { type: 'button', class: 'small quick', onclick: (e) => { e.stopPropagation(); allowDomain(p.domain); } }, `Allow ${p.domain}`));
    }
    if (cs.lesson && p.status === 'off' && !p.domain && p.appPackage) {
      quick.push(el('button', { type: 'button', class: 'small quick', onclick: (e) => { e.stopPropagation(); allowApp(p.appPackage); } }, `Allow ${p.appLabel || 'this app'}`));
    }
    const warn = p.connected && p.perms && cs.lesson && (!p.perms.usage || !p.perms.website)
      ? el('div', { class: 'detail' }, !p.perms.usage ? '⚠ App tracking permission off' : '⚠ Website check off')
      : null;
    return el('div', {
      class: `card s-${status}${selected ? ' selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-pressed': selected ? 'true' : 'false',
      onclick: () => toggleSelect(p.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(p.id); } },
    },
    el('span', { class: 'tick', 'aria-hidden': 'true' }),
    el('div', { class: 'name' }, p.name),
    el('div', { class: 'status' }, STATUS_TEXT[status] || status),
    el('div', { class: 'detail' }, cardDetail(p)),
    warn,
    quick,
    cs.lesson ? el('div', { class: 'linkstate' }, linkSummary(cs, p)) : null);
  }));
}

function toggleSelect(pupilId) {
  if (!state.classState || !state.classState.lesson) return;
  if (state.selected.has(pupilId)) state.selected.delete(pupilId);
  else state.selected.add(pupilId);
  render();
}

// ---- Lesson actions --------------------------------------------------------

async function updateAllowed(allowedDomains, allowedApps) {
  try {
    await api('PUT', `/api/classes/${state.classId}/lesson/allowed`, { allowedDomains, allowedApps });
  } catch (err) {
    $('linkError').textContent = err.message;
  }
}

function allowDomain(domain) {
  const current = state.classState.lesson.allowedDomains;
  if (!current.includes(domain)) updateAllowed([...current, domain]);
}

function allowApp(pkg) {
  const current = state.classState.lesson.allowedApps;
  if (!current.includes(pkg)) updateAllowed(undefined, [...current, pkg]);
}

async function sendLink(pupilIds) {
  $('linkError').textContent = '';
  const url = $('linkInput').value.trim();
  if (!url) {
    $('linkError').textContent = 'Paste a link first.';
    return;
  }
  try {
    await api('POST', `/api/classes/${state.classId}/links`, { url, pupilIds });
    $('linkInput').value = '';
    state.selected.clear();
    render();
  } catch (err) {
    $('linkError').textContent = err.message;
  }
}

// ---- Manage view -----------------------------------------------------------

async function loadManage() {
  const detail = $('classDetail');
  if (!state.classId) {
    detail.hidden = true;
    return;
  }
  const { class: cls, pupils } = await api('GET', `/api/classes/${state.classId}/pupils`);
  detail.hidden = false;
  $('classDetailTitle').textContent = cls.name;
  $('pupilRows').replaceChildren(...pupils.map((p) => el('tr', {},
    el('td', {}, p.name),
    el('td', {}, p.paired ? 'Set up ✓' : 'Not set up'),
    el('td', {},
      el('button', { type: 'button', class: 'small', onclick: () => showCode(p) }, p.paired ? 'Replace tablet' : 'Get setup code'),
      p.paired ? el('button', { type: 'button', class: 'small', onclick: () => unpair(p) }, 'Unpair') : null,
      el('button', { type: 'button', class: 'small danger', onclick: () => removePupil(p) }, 'Remove')),
  )));
  if (!pupils.length) $('pupilRows').append(el('tr', {}, el('td', { colspan: '3', class: 'hint' }, 'No pupils yet.')));
}

async function showCode(p) {
  if (p.paired && !confirm(`${p.name} already has a tablet set up. A new code will replace it when used. Continue?`)) return;
  const { code } = await api('POST', `/api/pupils/${p.id}/pairing-code`);
  $('codeName').textContent = p.name;
  $('codeValue').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $('codeServer').textContent = location.origin;
  $('codeDialog').showModal();
}

async function unpair(p) {
  if (!confirm(`Unpair ${p.name}'s tablet? It will stop connecting until set up again.`)) return;
  await api('POST', `/api/pupils/${p.id}/unpair`);
  loadManage();
}

async function removePupil(p) {
  if (!confirm(`Remove ${p.name} from this class?`)) return;
  await api('DELETE', `/api/classes/${state.classId}/pupils/${p.id}`);
  await loadClasses(state.classId);
  loadManage();
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
  $('navManage').addEventListener('click', () => setView('manage'));
  $('classSelect').addEventListener('change', (e) => {
    state.classId = e.target.value;
    localStorageSet('classId', state.classId);
    watchClass();
    if (state.view === 'manage') loadManage();
  });

  $('startAddCustom').addEventListener('click', () => {
    const d = normaliseDomain($('startCustom').value);
    if (d && !state.startDomains.includes(d)) state.startDomains.push(d);
    $('startCustom').value = '';
    render();
  });
  $('startLessonBtn').addEventListener('click', async () => {
    await api('POST', `/api/classes/${state.classId}/lesson/start`, { allowedDomains: state.startDomains });
  });
  $('endLessonBtn').addEventListener('click', async () => {
    if (!confirm('End the lesson? Activity for this lesson will be cleared.')) return;
    await api('POST', `/api/classes/${state.classId}/lesson/end`);
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

  $('newClassForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cls = await api('POST', '/api/classes', { name: $('newClassName').value });
    $('newClassName').value = '';
    localStorageSet('classId', cls.id);
    await loadClasses(cls.id);
    loadManage();
  });
  $('addPupilsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('POST', `/api/classes/${state.classId}/pupils`, { names: $('pupilNames').value });
    $('pupilNames').value = '';
    await loadClasses(state.classId);
    loadManage();
  });
  $('deleteClassBtn').addEventListener('click', async () => {
    const cls = state.classes.find((c) => c.id === state.classId);
    if (!confirm(`Delete the class “${cls ? cls.name : ''}”? Pupils stay paired.`)) return;
    await api('DELETE', `/api/classes/${state.classId}`);
    state.classId = null;
    await loadClasses();
    loadManage();
  });

  // Keep "last seen 2 min ago" text fresh without waiting for the server.
  setInterval(() => render(), 30_000);
}

async function start() {
  $('topbarControls').hidden = false;
  await loadClasses();
  setView(state.classes.length ? 'lesson' : 'manage');
  if (!state.ws) connect();
}

wire();
fetch('/api/me')
  .then((r) => r.json())
  .then(({ teacher }) => (teacher ? start() : showLogin()))
  .catch(showLogin);
