// End-to-end test of the main flow: teacher logs in, creates a class, a
// tablet pairs and connects, a lesson starts, a link is sent and acknowledged.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import { normaliseDomain, domainMatches, normaliseLink } from '../src/domains.js';

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

test('domain helpers', () => {
  assert.equal(normaliseDomain('https://www.BBC.co.uk/bitesize?x=1'), 'bbc.co.uk');
  assert.equal(normaliseDomain('not a domain'), null);
  assert.equal(domainMatches('www.bbc.co.uk', ['bbc.co.uk']), 'bbc.co.uk');
  assert.equal(domainMatches('notbbc.co.uk', ['bbc.co.uk']), null);
  assert.equal(normaliseLink('bbc.co.uk/bitesize'), 'https://bbc.co.uk/bitesize');
  assert.equal(normaliseLink('javascript:alert(1)'), null);
});

test('pair a tablet, run a lesson, send a link', async (t) => {
  const { server } = createApp({ password: 'secret', log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
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

  // Wrong password is rejected; API is protected.
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await call('GET', '/api/classes')).status, 401);

  const login = await call('POST', '/api/login', { password: 'secret' });
  const cookie = login.res.headers.get('set-cookie').split(';')[0];

  const cls = (await call('POST', '/api/classes', { name: 'S2 Computing' }, cookie)).data;
  await call('POST', `/api/classes/${cls.id}/pupils`, { names: 'Amy K\nBen M' }, cookie);
  const { pupils } = (await call('GET', `/api/classes/${cls.id}/pupils`, null, cookie)).data;
  const amy = pupils.find((p) => p.name === 'Amy K');

  // Pairing codes work once only.
  const { code } = (await call('POST', `/api/pupils/${amy.id}/pairing-code`, null, cookie)).data;
  const paired = await call('POST', '/api/device/pair', { code });
  assert.equal(paired.data.pupilName, 'Amy K');
  assert.equal((await call('POST', '/api/device/pair', { code })).status, 400);

  // Tablets without a valid token cannot connect.
  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws/device`, { headers: { Authorization: 'Bearer wrong' } });
  await new Promise((resolve) => bad.on('error', resolve));

  const teacher = new WebSocket(`${base.replace('http', 'ws')}/ws/teacher`, { headers: { Cookie: cookie } });
  sockets.push(teacher);
  await new Promise((r) => teacher.on('open', r));
  teacher.send(JSON.stringify({ type: 'watch', classId: cls.id }));
  await waitFor(teacher, (m) => m.type === 'classState');

  const device = new WebSocket(`${base.replace('http', 'ws')}/ws/device`, { headers: { Authorization: `Bearer ${paired.data.token}` } });
  sockets.push(device);
  const welcome = waitFor(device, (m) => m.type === 'welcome');
  await new Promise((r) => device.on('open', r));
  assert.equal((await welcome).pupilName, 'Amy K');

  // No lesson yet: dashboard shows "connected" only.
  let snap = await waitFor(teacher, (m) => m.type === 'classState' && m.pupils.some((p) => p.connected));
  assert.equal(snap.pupils.find((p) => p.id === amy.id).status, 'connected');

  // Start a lesson: the tablet receives the allowed list.
  const lessonMsg = waitFor(device, (m) => m.type === 'lesson' && m.active);
  await call('POST', `/api/classes/${cls.id}/lesson/start`, { allowedDomains: ['bbc.co.uk'] }, cookie);
  assert.deepEqual((await lessonMsg).allowedDomains, ['bbc.co.uk']);

  device.send(JSON.stringify({ type: 'status', state: 'off', appLabel: 'Silk', domain: 'www.youtube.com', screenOn: true, perms: { usage: true, website: true } }));
  snap = await waitFor(teacher, (m) => m.type === 'classState' && m.pupils.find((p) => p.id === amy.id).status === 'off');
  assert.equal(snap.pupils.find((p) => p.id === amy.id).domain, 'youtube.com');

  // Send a link: its site joins the allowed list; acks update the dashboard.
  const linkMsg = waitFor(device, (m) => m.type === 'link');
  await call('POST', `/api/classes/${cls.id}/links`, { url: 'https://classroom.google.com/c/abc' }, cookie);
  const link = await linkMsg;
  device.send(JSON.stringify({ type: 'linkAck', id: link.id, stage: 'delivered' }));
  device.send(JSON.stringify({ type: 'linkAck', id: link.id, stage: 'opened' }));
  snap = await waitFor(teacher, (m) => m.type === 'classState' && m.pupils.find((p) => p.id === amy.id).links[link.id] === 'opened');
  assert.ok(snap.lesson.allowedDomains.includes('classroom.google.com'));
  // Ben has no tablet, so his copy is still waiting.
  assert.equal(snap.pupils.find((p) => p.name === 'Ben M').links[link.id], 'sent');

  // Ending the lesson clears activity.
  await call('POST', `/api/classes/${cls.id}/lesson/end`, null, cookie);
  snap = await waitFor(teacher, (m) => m.type === 'classState' && !m.lesson);
  const amyView = snap.pupils.find((p) => p.id === amy.id);
  assert.equal(amyView.status, 'connected');
  assert.equal(amyView.domain, null);
});
