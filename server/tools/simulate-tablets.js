// Pretend to be a classroom of Fire tablets, so the dashboard can be tried
// without real devices.
//
//   TEACHER_PASSWORD=... node tools/simulate-tablets.js [hubUrl] [pupilCount]
//
// It creates a class called "Demo class" (if missing), sets up fake tablets
// for its pupils, then reports made-up activity using the same on-task rules
// as the real Android app.

import WebSocket from 'ws';

const hub = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = Number(process.argv[3]) || 24;
const password = process.env.TEACHER_PASSWORD;
if (!password) {
  console.error('Set TEACHER_PASSWORD to the hub password.');
  process.exit(1);
}

const NAMES = ['Amy K', 'Ben M', 'Callum R', 'Chloe S', 'Daniel W', 'Ella T', 'Finlay G', 'Freya B', 'Grace H', 'Harris D',
  'Isla P', 'Jack F', 'Kai L', 'Lily C', 'Lewis N', 'Mia O', 'Noah J', 'Olivia A', 'Rory E', 'Sophie V', 'Struan Q',
  'Ava Y', 'Leo Z', 'Ruby X', 'Zara U', 'Euan I', 'Millie R', 'Archie T', 'Eilidh M', 'Lucas S'];

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
    return matched
      ? { state: 'on', appLabel: 'Silk', matched }
      : { state: 'off', appLabel: 'Silk', domain: host };
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

function simulateTablet(token, name) {
  let lesson = null;
  let activity = pick();
  let ws;

  const report = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const c = classify(activity, lesson);
    ws.send(JSON.stringify({
      type: 'status', screenOn: true, ...c, perms: { usage: true, website: true },
      battery: 40 + Math.round(Math.random() * 60), appVersion: 'sim',
    }));
  };

  const open = () => {
    ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/ws/device`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'lesson') {
        lesson = msg;
        report();
      } else if (msg.type === 'link') {
        ws.send(JSON.stringify({ type: 'linkAck', id: msg.id, stage: 'delivered' }));
        if (Math.random() < 0.8) {
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'linkAck', id: msg.id, stage: 'opened' }));
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

  // Every so often the pupil switches to something else.
  setInterval(() => {
    if (Math.random() < 0.15) activity = pick();
    report();
  }, 5000 + Math.random() * 5000);
  console.log(`  tablet for ${name} running`);
}

const { res } = await api('POST', '/api/login', { password });
const cookie = res.headers.get('set-cookie').split(';')[0];

const { data: { classes } } = await api('GET', '/api/classes', null, cookie);
let cls = classes.find((c) => c.name === 'Demo class');
if (!cls) {
  cls = (await api('POST', '/api/classes', { name: 'Demo class' }, cookie)).data;
  await api('POST', `/api/classes/${cls.id}/pupils`, { names: NAMES.slice(0, count).join('\n') }, cookie);
}
const { data: { pupils } } = await api('GET', `/api/classes/${cls.id}/pupils`, null, cookie);

console.log(`Simulating ${pupils.length - 2} tablets for "Demo class" (2 pupils left without a tablet)...`);
for (const pupil of pupils.slice(0, pupils.length - 2)) {
  const { data: { code } } = await api('POST', `/api/pupils/${pupil.id}/pairing-code`, null, cookie);
  const { data: { token } } = await api('POST', '/api/device/pair', { code });
  simulateTablet(token, pupil.name);
}
