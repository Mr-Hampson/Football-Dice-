// Pretend to be a trolley of Fire tablets, so the dashboard can be tried
// without real devices.
//
//   TEACHER_PASSWORD=... node tools/simulate-tablets.js [hubUrl] [tabletCount]
//
// It sets up tablets numbered 1..N, waits for a lesson to be started on the
// dashboard, then most tablets "join" with made-up pupil names (one is a
// duplicate; two never join) and report activity using the same on-task
// rules as the real Android app.

import WebSocket from 'ws';

const hub = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = Number(process.argv[3]) || 24;
const password = process.env.TEACHER_PASSWORD;
if (!password) {
  console.error('Set TEACHER_PASSWORD to the hub password.');
  process.exit(1);
}

const NAMES = ['Amy K', 'Ben M', 'Callum R', 'Chloe S', 'Daniel W', 'Ella T', 'Finlay G', 'Freya B', 'Grace H', 'Harris D',
  'Isla P', 'Jack F', 'Kai L', 'Lily C', 'Lewis N', 'Mia O', 'Noah J', 'Olivia A', 'Rory E', 'Sophie V', 'Amy K',
  'Ava Y', 'Leo Z', 'Ruby X', 'Zara U', 'Euan I', 'Millie R', 'Archie T', 'Eilidh M', 'Lucas S'];
const NEVER_JOIN = 2;

// Things a pupil might be doing. "domain" means they are in Silk on that site.
const ACTIVITIES = [
  { pkg: 'com.amazon.cloud9', label: 'Silk', domain: 'www.bbc.co.uk', weight: 6 },
  { pkg: 'com.amazon.cloud9', label: 'Silk', domain: 'classroom.google.com', weight: 3 },
  { pkg: 'com.amazon.cloud9', label: 'Silk', domain: 'www.youtube.com', weight: 1 },
  { pkg: 'com.amazon.cloud9', label: 'Silk', domain: 'www.coolmathgames.com', weight: 1 },
  { pkg: 'com.amazon.cloud9', label: 'Silk', domain: null, weight: 1 }, // website check couldn't read it
  { pkg: 'com.amazon.firelauncher', label: 'Home', home: true, weight: 1 },
  { pkg: 'com.google.android.youtube', label: 'YouTube', weight: 1 },
  { pkg: 'com.amazon.kindle', label: 'Kindle', weight: 1 },
];

function pick() {
  const total = ACTIVITIES.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of ACTIVITIES) if ((r -= a.weight) < 0) return a;
  return ACTIVITIES[0];
}

// Same rule as Classifier.kt in the Android app.
function classify(activity, lesson) {
  if (!lesson || !lesson.active) return { state: 'paused' };
  if (activity.home) return { state: 'idle', appLabel: 'Home screen' };
  if (lesson.allowedApps.includes(activity.pkg)) return { state: 'on', appLabel: activity.label };
  if (activity.pkg === 'com.amazon.cloud9') {
    if (!activity.domain) return { state: 'unknown', appLabel: 'Silk', detail: "Silk – couldn't read the website" };
    const host = activity.domain.replace(/^www\./, '');
    const matched = lesson.allowedDomains.find((a) => host === a || host.endsWith(`.${a}`));
    return matched ? { state: 'on', appLabel: 'Silk', matched } : { state: 'off', appLabel: 'Silk', domain: host };
  }
  return { state: 'off', appLabel: activity.label, appPackage: activity.pkg };
}

async function api(method, path, body, cookie) {
  const res = await fetch(`${hub}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error || res.status}`);
  return { data, res };
}

function simulateTablet(token, number, name, getJoinCode) {
  let lesson = null;
  let activity = pick();
  let ws;
  const send = (m) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  const report = () => {
    const c = classify(activity, lesson);
    send({ type: 'status', screenOn: true, ...c, perms: { usage: true, website: true }, battery: 40 + Math.round(Math.random() * 60), appVersion: 'sim' });
  };

  const open = () => {
    ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/ws/device`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'lesson') {
        lesson = msg;
        if (msg.active && msg.nameRequested) {
          // The pupil fixes their name after a few seconds.
          setTimeout(() => send({ type: 'rename', name: `${name.split(' ')[0]} ${String.fromCharCode(65 + number % 26)}` }), 4000);
        }
        report();
      } else if (msg.type === 'message') {
        // The pop-up arrives at once; the pupil presses OK a few seconds later.
        send({ type: 'messageAck', id: msg.id, stage: 'delivered' });
        setTimeout(() => send({ type: 'messageAck', id: msg.id, stage: 'seen' }), 1500 + Math.random() * 6000);
      } else if (msg.type === 'link') {
        send({ type: 'linkAck', id: msg.id, stage: 'delivered' });
        if (Math.random() < 0.8) {
          setTimeout(() => {
            send({ type: 'linkAck', id: msg.id, stage: 'opened' });
            activity = { pkg: 'com.amazon.cloud9', label: 'Silk', domain: new URL(msg.url).hostname, weight: 0 };
            report();
          }, 2000 + Math.random() * 10000);
        }
      }
    });
    ws.on('close', () => setTimeout(open, 3000));
    ws.on('error', () => {});
  };
  open();

  setInterval(() => {
    // Not in a lesson? Join if the teacher has started one (some pupils never do).
    if (name && (!lesson || !lesson.active)) {
      const code = getJoinCode();
      if (code && Math.random() < 0.4) send({ type: 'join', code, name });
      return;
    }
    if (Math.random() < 0.15) activity = pick();
    report();
  }, 3000 + Math.random() * 4000);
}

const { res } = await api('POST', '/api/login', { password });
const cookie = res.headers.get('set-cookie').split(';')[0];
const { data: { code: setupCode } } = await api('POST', '/api/tablets/setup-code', null, cookie);

// Watch for a running lesson so the pretend pupils know the join code.
let joinCode = null;
setInterval(async () => {
  try {
    const { data: { lessons } } = await api('GET', '/api/lessons', null, cookie);
    joinCode = lessons.length ? lessons[lessons.length - 1].joinCode : null;
  } catch { /* hub restarting */ }
}, 2000);

console.log(`Setting up ${count} tablets. Start a lesson on the dashboard and they will join (${NEVER_JOIN} never will).`);
for (let i = 1; i <= count; i++) {
  const { data: { token } } = await api('POST', '/api/device/enrol', { code: setupCode, number: String(i) });
  simulateTablet(token, i, i <= count - NEVER_JOIN ? NAMES[(i - 1) % NAMES.length] : null, () => joinCode);
}
