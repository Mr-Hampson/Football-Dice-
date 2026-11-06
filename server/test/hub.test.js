// End-to-end test of the main flow: a tablet is set up with its number, a
// teacher starts a lesson, a pupil joins with the code and their name, the
// teacher sends a link, asks for a retyped name, and ends the lesson.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import { normaliseDomain, domainMatches, normaliseLink } from '../src/domains.js';
import { normalisePupilName } from '../src/names.js';
import { normaliseTabletNumber } from '../src/store.js';

// Collects every message so a test can wait for one that already arrived.
function inbox(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  return {
    next(predicate, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for: ' + predicate.toString())), timeoutMs);
        waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    // Like next(), but also matches the most recent message already received.
    latest(predicate, timeoutMs) {
      const last = [...messages].reverse().find(predicate);
      return last ? Promise.resolve(last) : this.next(predicate, timeoutMs);
    },
  };
}

test('helpers', () => {
  assert.equal(normaliseDomain('https://www.BBC.co.uk/bitesize?x=1'), 'bbc.co.uk');
  assert.equal(domainMatches('notbbc.co.uk', ['bbc.co.uk']), null);
  assert.equal(normaliseLink('javascript:alert(1)'), null);
  assert.equal(normalisePupilName('  amy   k. '), 'Amy K');
  assert.equal(normalisePupilName('Mary-Jane o'), 'Mary-Jane O');
  assert.equal(normalisePupilName('Seán Ó'), 'Seán Ó');
  assert.equal(normalisePupilName('Amy'), null); // no initial
  assert.equal(normalisePupilName('Amy Kerr'), null); // full surname
  assert.equal(normalisePupilName('x1 k'), null);
  assert.equal(normaliseTabletNumber('07'), '7');
  assert.equal(normaliseTabletNumber('a 12'), 'A12');
  assert.equal(normaliseTabletNumber('!!'), null);
});

test('set up tablets, join a lesson, send a link, rename, end', async (t) => {
  const { server } = createApp({ password: 'secret', log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const wsBase = base.replace('http', 'ws');
  const sockets = [];
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    server.close();
  });

  const call = async (method, path, body, cookie) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json(), res };
  };

  // Teacher API is protected.
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await call('GET', '/api/lessons')).status, 401);
  const login = await call('POST', '/api/login', { password: 'secret' });
  const cookie = login.res.headers.get('set-cookie').split(';')[0];

  // Set up two tablets with one setup code.
  assert.equal((await call('POST', '/api/device/enrol', { code: 'WRONG', number: '1' })).status, 400);
  const { code: setupCode } = (await call('POST', '/api/tablets/setup-code', null, cookie)).data;
  const t7 = (await call('POST', '/api/device/enrol', { code: setupCode, number: '07' })).data;
  const t8 = (await call('POST', '/api/device/enrol', { code: setupCode, number: '8' })).data;
  assert.equal(t7.number, '7');

  const connectTablet = async (token) => {
    const ws = new WebSocket(`${wsBase}/ws/device`, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(ws);
    const box = inbox(ws);
    await new Promise((r) => ws.on('open', r));
    return { ws, box, send: (m) => ws.send(JSON.stringify(m)) };
  };

  // Unknown tablets cannot connect.
  const bad = new WebSocket(`${wsBase}/ws/device`, { headers: { Authorization: 'Bearer wrong' } });
  await new Promise((resolve) => bad.on('error', resolve));

  const teacher = new WebSocket(`${wsBase}/ws/teacher`, { headers: { Cookie: cookie } });
  sockets.push(teacher);
  const tbox = inbox(teacher);
  await new Promise((r) => teacher.on('open', r));

  const tab7 = await connectTablet(t7.token);
  const tab8 = await connectTablet(t8.token);
  assert.equal((await tab7.box.latest((m) => m.type === 'welcome')).tabletNumber, '7');

  // Start a lesson and watch it.
  const { id: lessonId, joinCode } = (await call('POST', '/api/lessons', { title: 'S2 Computing', allowedDomains: ['bbc.co.uk'] }, cookie)).data;
  assert.match(joinCode, /^[A-Z0-9]{4}$/);
  teacher.send(JSON.stringify({ type: 'watch', lessonId }));
  let snap = await tbox.next((m) => m.type === 'lessonState' && m.lesson && m.unjoinedTablets.length === 2);
  assert.deepEqual(snap.unjoinedTablets, ['7', '8']);

  // Wrong code and badly formed names are rejected.
  tab7.send({ type: 'join', code: 'ZZZZ', name: 'Amy K' });
  assert.match((await tab7.box.next((m) => m.type === 'joinError')).error, /not recognised/);
  tab7.send({ type: 'join', code: joinCode, name: 'Amy' });
  assert.match((await tab7.box.next((m) => m.type === 'joinError')).error, /first letter of your surname/);

  // Two pupils join, one with a duplicate name.
  tab7.send({ type: 'join', code: joinCode.toLowerCase(), name: 'amy k' });
  const joined = await tab7.box.next((m) => m.type === 'lesson' && m.active);
  assert.equal(joined.name, 'Amy K');
  assert.deepEqual(joined.allowedDomains, ['bbc.co.uk']);
  tab8.send({ type: 'join', code: joinCode, name: 'Amy K' });
  await tab8.box.next((m) => m.type === 'lesson' && m.active);

  snap = await tbox.next((m) => m.type === 'lessonState' && m.pupils && m.pupils.length === 2 && m.unjoinedTablets.length === 0);
  assert.ok(snap.pupils.every((p) => p.duplicateName));
  const id7 = snap.pupils.find((p) => p.tabletNumber === '7').id;
  const id8 = snap.pupils.find((p) => p.tabletNumber === '8').id;

  // Status from the tablet shows on the dashboard.
  tab7.send({ type: 'status', state: 'off', appLabel: 'Silk', domain: 'www.youtube.com', screenOn: true, perms: { usage: true, website: true } });
  snap = await tbox.next((m) => m.type === 'lessonState' && m.pupils.find((p) => p.id === id7).status === 'off');
  assert.equal(snap.pupils.find((p) => p.id === id7).domain, 'youtube.com');

  // Teacher asks tablet 8 to retype its name.
  const asked = tab8.box.next((m) => m.type === 'lesson' && m.nameRequested === true);
  await call('POST', `/api/lessons/${lessonId}/rename-requests`, { tabletIds: [id8] }, cookie);
  await asked;
  tab8.send({ type: 'rename', name: 'Ben M' });
  await tab8.box.next((m) => m.type === 'lesson' && m.name === 'Ben M' && !m.nameRequested);
  snap = await tbox.next((m) => m.type === 'lessonState' && m.pupils.some((p) => p.name === 'Ben M'));
  assert.ok(snap.pupils.every((p) => !p.duplicateName));

  // A link to one pupil only; its site joins the allowed list.
  const linkMsg = tab7.box.next((m) => m.type === 'link');
  await call('POST', `/api/lessons/${lessonId}/links`, { url: 'https://classroom.google.com/c/abc', tabletIds: [id7] }, cookie);
  const link = await linkMsg;
  tab7.send({ type: 'linkAck', id: link.id, stage: 'delivered' });
  tab7.send({ type: 'linkAck', id: link.id, stage: 'opened' });
  snap = await tbox.next((m) => m.type === 'lessonState' && m.pupils.find((p) => p.id === id7).links[link.id] === 'opened');
  assert.ok(snap.lesson.allowedDomains.includes('classroom.google.com'));
  assert.equal(snap.pupils.find((p) => p.id === id8).links[link.id], undefined);

  // Removing a pupil sends their tablet back to the join screen.
  const removed = tab8.box.next((m) => m.type === 'lesson' && !m.active);
  await call('POST', `/api/lessons/${lessonId}/remove`, { tabletIds: [id8] }, cookie);
  await removed;
  snap = await tbox.next((m) => m.type === 'lessonState' && m.unjoinedTablets.includes('8'));
  assert.equal(snap.pupils.length, 1);

  // Ending the lesson releases every tablet and forgets names.
  const ended = tab7.box.next((m) => m.type === 'lesson' && !m.active);
  await call('POST', `/api/lessons/${lessonId}/end`, null, cookie);
  await ended;
  snap = await tbox.next((m) => m.type === 'lessonState' && !m.lesson);
  assert.equal(snap.ended, true);
  assert.deepEqual(snap.unjoinedTablets, ['7', '8']);
  assert.equal((await call('GET', '/api/lessons', null, cookie)).data.lessons.length, 0);
});

test('lessons end automatically after the time limit', async () => {
  const { hub, server } = createApp({ password: 'x', log: () => {} });
  const lesson = hub.startLesson({ title: 'Test' });
  hub.endExpiredLessons(lesson.endsAt + 1);
  assert.equal(hub.listLessons().length, 0);
  server.close();
});

test('behind a proxy, wrong passwords only lock out the person typing them', async (t) => {
  const { server } = createApp({ password: 'right', trustProxy: true, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = (password, ip) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.4, ${ip}` },
    body: JSON.stringify({ password }),
  }).then((r) => r.status);

  for (let i = 0; i < 10; i++) assert.equal(await login('wrong', '10.0.0.1'), 401);
  assert.equal(await login('right', '10.0.0.1'), 429); // this person is locked out
  assert.equal(await login('right', '10.0.0.2'), 200); // other teachers are not
});

test('/app forwards tablets to the newest app download', async (t) => {
  const { server } = createApp({ password: 'x', log: () => {} });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const res = await fetch(`http://localhost:${server.address().port}/app`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /releases\/latest\/download\/classroom-hub\.apk$/);
});

test('messages pop up on tablets, and screens freeze and thaw', async (t) => {
  const { server, hub, store } = createApp({ password: 'x', releasesApi: null, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const wsBase = `ws://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); server.close(); });

  const { code } = store.createSetupCode();
  const { token, tablet } = store.enrolTablet(code, '3');
  const ws = new WebSocket(`${wsBase}/ws/device`, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const box = inbox(ws);
  await new Promise((r) => ws.on('open', r));

  const lesson = hub.startLesson({ title: 'Test' });
  ws.send(JSON.stringify({ type: 'join', code: lesson.joinCode, name: 'Amy K' }));
  await box.next((m) => m.type === 'lesson' && m.active);

  // Message: delivered, then seen when the pupil presses OK.
  const got = box.next((m) => m.type === 'message');
  assert.throws(() => hub.sendMessage(lesson.id, { text: '   ' }), /Type a message/);
  const msg = hub.sendMessage(lesson.id, { text: 'Back on task, please' });
  assert.equal((await got).text, 'Back on task, please');
  ws.send(JSON.stringify({ type: 'messageAck', id: msg.id, stage: 'delivered' }));
  ws.send(JSON.stringify({ type: 'messageAck', id: msg.id, stage: 'seen' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.lessonState(lesson.id).pupils[0].messages[msg.id], 'seen');

  // Freeze: the tablet is told how long is left; unfreeze clears it.
  const frozen = box.next((m) => m.type === 'lesson' && m.freeze);
  hub.freeze(lesson.id, { text: 'Eyes on me' });
  const f = (await frozen).freeze;
  assert.equal(f.text, 'Eyes on me');
  assert.ok(f.remainingMs > 4.9 * 60_000 && f.remainingMs <= 5 * 60_000);
  assert.ok(hub.lessonState(lesson.id).pupils[0].frozen);
  const thawed = box.next((m) => m.type === 'lesson' && m.active && !m.freeze);
  hub.unfreeze(lesson.id);
  await thawed;

  // A freeze always ends on its own.
  hub.freeze(lesson.id, { minutes: 1 });
  const expired = box.next((m) => m.type === 'lesson' && m.active && !m.freeze);
  hub.endExpiredLessons(Date.now() + 61_000);
  await expired;
  assert.equal(hub.lessonState(lesson.id).pupils[0].frozen, null);
  assert.equal(tablet.number, '3');
});

test('help requests, needs-attention, tablet health and tablet settings', async (t) => {
  const deviceConfig = { urlBarIds: ['com.amazon.cloud9:id/new_bar'], urlHints: ['url'] };
  const { server, hub, store } = createApp({ password: 'x', releasesApi: null, deviceConfig, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const wsBase = `ws://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); server.close(); });

  const { code } = store.createSetupCode();
  const { token, tablet } = store.enrolTablet(code, '5');
  const ws = new WebSocket(`${wsBase}/ws/device`, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const box = inbox(ws);
  await new Promise((r) => ws.on('open', r));

  // Settings arrive as soon as the tablet connects.
  const cfg = await box.latest((m) => m.type === 'config');
  assert.deepEqual(cfg.urlBarIds, ['com.amazon.cloud9:id/new_bar']);

  // Health is recorded even outside a lesson; problems are flagged.
  ws.send(JSON.stringify({ type: 'status', state: 'paused', perms: { usage: true, website: false }, battery: 12, appVersion: '0.1.9' }));
  await new Promise((r) => setTimeout(r, 100));
  const [row] = hub.tabletsOverview(13);
  assert.equal(row.number, '5');
  assert.ok(row.problems.includes('Website check is off'));
  assert.ok(row.problems.includes('Battery low (12%)'));
  assert.ok(row.problems.includes('App needs updating'));

  const lesson = hub.startLesson({ title: 'Test', allowedDomains: ['bbc.co.uk'] });
  ws.send(JSON.stringify({ type: 'join', code: lesson.joinCode, name: 'Amy K' }));
  await box.next((m) => m.type === 'lesson' && m.active);

  // "I need help": shows on the card until the teacher clears it.
  const asked = box.next((m) => m.type === 'lesson' && m.helpRequested === true);
  ws.send(JSON.stringify({ type: 'help', on: true }));
  await asked;
  let view = hub.lessonState(lesson.id).pupils[0];
  assert.ok(view.helpRequested && view.needsAttention);
  const cleared = box.next((m) => m.type === 'lesson' && m.helpRequested === false);
  hub.clearHelp(lesson.id);
  await cleared;

  // Off task for over 2 minutes = needs attention.
  ws.send(JSON.stringify({ type: 'status', state: 'off', appLabel: 'Silk', domain: 'youtube.com', screenOn: true, perms: { usage: true, website: true } }));
  await new Promise((r) => setTimeout(r, 100));
  view = hub.lessonState(lesson.id).pupils[0];
  assert.equal(view.needsAttention, false);
  hub.live.get(tablet.id).offSince -= 3 * 60 * 1000; // pretend it has been 3 minutes
  view = hub.lessonState(lesson.id).pupils[0];
  assert.ok(view.offForMs >= 3 * 60 * 1000 && view.needsAttention);
  // Back on task resets the clock.
  ws.send(JSON.stringify({ type: 'status', state: 'on', appLabel: 'Silk', matched: 'bbc.co.uk', screenOn: true, perms: { usage: true, website: true } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.lessonState(lesson.id).pupils[0].needsAttention, false);
});

test('audit log entries are deleted after the retention period', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audit-'));
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'audit.log'), `${JSON.stringify({ at: old, action: 'old' })}\n${JSON.stringify({ at: new Date().toISOString(), action: 'new' })}\n`);
  const { server } = createApp({ password: 'x', dataDir: dir, auditRetentionDays: 120, log: () => {} });
  const lines = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).action);
  assert.deepEqual(lines, ['new']);
  server.close();
});

test('audit log is encrypted on disk when AUDIT_KEY is set', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-enc-'));
  const { server, hub } = createApp({ password: 'x', dataDir: dir, auditKey: 'test-key', log: () => {} });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const lesson = hub.startLesson({ title: 'Secret lesson title' });
  const raw = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.ok(raw.startsWith('enc1:'));
  assert.ok(!raw.includes('Secret lesson title'));
  // Still readable through the dashboard.
  const base = `http://localhost:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { entries } = await (await fetch(`${base}/api/audit`, { headers: { Cookie: cookie } })).json();
  assert.ok(entries.some((e) => e.title === 'Secret lesson title' && e.lessonId === lesson.id));
});

test('dashboard can be limited to the school network; tablets are not', async (t) => {
  const { server, store } = createApp({ password: 'x', trustProxy: true, teacherAllowedIps: '203.0.113.7,198.51.100.0/24', cookieSecure: true, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = (ip) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ password: 'x' }),
  });
  assert.equal((await login('8.8.8.8')).status, 403);
  assert.equal((await login('203.0.113.7')).status, 200);
  const inRange = await login('198.51.100.42');
  assert.equal(inRange.status, 200);
  assert.match(inRange.headers.get('strict-transport-security'), /max-age/);
  // Tablets set up from anywhere (e.g. the public Wi-Fi).
  const { code } = store.createSetupCode();
  const enrol = await fetch(`${base}/api/device/enrol`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' }, body: JSON.stringify({ code, number: '1' }),
  });
  assert.equal(enrol.status, 200);
});
