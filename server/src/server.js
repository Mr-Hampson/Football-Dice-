// Entry point: an HTTP server for the teacher dashboard and API, plus two
// WebSocket endpoints (persistent two-way connections):
//   /ws/teacher - dashboards receive live class updates
//   /ws/device  - tablets join lessons, report status and receive links
//
// Configuration (environment variables):
//   PORT              port to listen on (default 3000)
//   TEACHER_PASSWORD  shared teacher password (prototype only - see README)
//   DATA_DIR          where the JSON data file and audit log live (default ./data)
//   COOKIE_SECURE     set to "true" when served over HTTPS (it should be!)
//   LESSON_MAX_MINUTES lessons end automatically after this long (default 120)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { Hub } from './hub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Very small rate limiter that counts FAILED attempts only. Tablets on public
// Wi-Fi usually share one public IP address, so counting every request would
// lock out a whole class setting up at once.
function makeFailureLimiter(maxFailures, windowMs) {
  const hits = new Map();
  const entryFor = (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    return entry;
  };
  return {
    blocked: (key) => entryFor(key).count >= maxFailures,
    fail: (key) => { entryFor(key).count += 1; },
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({
  password,
  dataDir = null,
  cookieSecure = false,
  lessonMaxMinutes = 120,
  log = console.log,
} = {}) {
  if (!password) throw new Error('A teacher password is required');
  const store = new Store(dataDir ? path.join(dataDir, 'store.json') : null);

  // The audit log records what teachers DO (start lessons, send links),
  // never what pupils do.
  const auditPath = dataDir ? path.join(dataDir, 'audit.log') : null;
  const audit = (action, details = {}) => {
    if (!auditPath) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), action, ...details })}\n`);
  };

  const hub = new Hub(store, { audit, lessonMaxMs: lessonMaxMinutes * 60 * 1000 });
  const sessions = new Map(); // token -> expiresAt
  const loginLimiter = makeFailureLimiter(10, 15 * 60 * 1000);
  const setupLimiter = makeFailureLimiter(30, 15 * 60 * 1000);

  function isTeacher(req) {
    const token = parseCookies(req.headers.cookie).hub_session;
    const expiresAt = token && sessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function clientIp(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { status: 400 });
    }
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(file).pipe(res);
  }

  // Routes are matched in order: [method, regex, needsTeacher, handler].
  const routes = [
    ['POST', /^\/api\/login$/, false, async (req, res) => {
      if (loginLimiter.blocked(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      const body = await readJson(req);
      if (!safeEqual(body.password || '', password)) {
        loginLimiter.fail(clientIp(req));
        audit('teacher.login.failed', { ip: clientIp(req) });
        return send(res, 401, { error: 'Wrong password' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      audit('teacher.login', { ip: clientIp(req) });
      const cookie = `hub_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${cookieSecure ? '; Secure' : ''}`;
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }],
    ['POST', /^\/api\/logout$/, false, async (req, res) => {
      sessions.delete(parseCookies(req.headers.cookie).hub_session);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }],
    ['GET', /^\/api\/me$/, false, async (req, res) => send(res, 200, { teacher: isTeacher(req) })],

    // ---- Lessons (teacher) ----
    ['GET', /^\/api\/lessons$/, true, async (req, res) => send(res, 200, { lessons: hub.listLessons() })],
    ['POST', /^\/api\/lessons$/, true, async (req, res) => {
      const lesson = hub.startLesson(await readJson(req));
      return send(res, 201, { id: lesson.id, joinCode: lesson.joinCode });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/end$/, true, async (req, res, [lessonId]) => {
      hub.endLesson(lessonId);
      return send(res, 200, { ok: true });
    }],
    ['PUT', /^\/api\/lessons\/([a-f0-9]+)\/allowed$/, true, async (req, res, [lessonId]) => {
      const lesson = hub.updateAllowed(lessonId, await readJson(req));
      return send(res, 200, { allowedDomains: lesson.allowedDomains, allowedApps: lesson.allowedApps });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/links$/, true, async (req, res, [lessonId]) => {
      const link = hub.sendLink(lessonId, await readJson(req));
      return send(res, 201, { id: link.id, url: link.url });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/rename-requests$/, true, async (req, res, [lessonId]) => {
      hub.requestRename(lessonId, (await readJson(req)).tabletIds);
      return send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/remove$/, true, async (req, res, [lessonId]) => {
      hub.removeMany(lessonId, (await readJson(req)).tabletIds);
      return send(res, 200, { ok: true });
    }],

    // ---- Tablets (teacher / IT) ----
    ['GET', /^\/api\/tablets$/, true, async (req, res) => send(res, 200, { tablets: hub.tabletsOverview() })],
    ['POST', /^\/api\/tablets\/setup-code$/, true, async (req, res) => {
      const entry = store.createSetupCode();
      audit('tablet.setupCode');
      return send(res, 200, { code: entry.code, expiresAt: entry.expiresAt });
    }],
    ['DELETE', /^\/api\/tablets\/([a-f0-9]+)$/, true, async (req, res, [tabletId]) => {
      const tablet = store.getTablet(tabletId);
      hub.forgetTablet(tabletId);
      store.removeTablet(tabletId);
      audit('tablet.remove', { number: tablet ? tablet.number : null });
      return send(res, 200, { ok: true });
    }],

    // Called once by each tablet during setup, with the school setup code
    // and the number on the tablet's sticker.
    ['POST', /^\/api\/device\/enrol$/, false, async (req, res) => {
      if (setupLimiter.blocked(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      const body = await readJson(req);
      const result = store.enrolTablet(body.code, body.number);
      if (result.error) {
        if (!store.isValidSetupCode(body.code)) setupLimiter.fail(clientIp(req));
        return send(res, 400, { error: result.error });
      }
      if (result.replaced) hub.forgetTablet(result.replaced.id);
      audit('tablet.enrol', { number: result.tablet.number, replacedExisting: !!result.replaced });
      hub.broadcastAll();
      return send(res, 200, { token: result.token, number: result.tablet.number });
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) {
        for (const [method, re, needsTeacher, handler] of routes) {
          const match = pathname.match(re);
          if (!match || req.method !== method) continue;
          if (needsTeacher && !isTeacher(req)) return send(res, 401, { error: 'Please log in' });
          return await handler(req, res, match.slice(1));
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (pathname === '/healthz') return send(res, 200, 'ok');
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return send(res, 405, 'Method not allowed');
    } catch (err) {
      const status = err.status || 400;
      if (status >= 500) log(err);
      return send(res, status, { error: err.message || 'Something went wrong' });
    }
  });

  // ---- WebSockets --------------------------------------------------------

  const teacherWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  function keepAlive(ws) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    return ws;
  }

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (pathname === '/ws/teacher') {
      // Block other websites from opening a dashboard connection using the
      // teacher's cookie (cross-site WebSocket hijacking).
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return reject(403, 'Forbidden');
      if (!isTeacher(req)) return reject(401, 'Unauthorized');
      teacherWss.handleUpgrade(req, socket, head, (ws) => hub.attachTeacher(keepAlive(ws)));
    } else if (pathname === '/ws/device') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const tablet = store.tabletForToken(token);
      if (!tablet) return reject(401, 'Unauthorized');
      deviceWss.handleUpgrade(req, socket, head, (ws) => hub.attachDevice(tablet, keepAlive(ws)));
    } else {
      reject(404, 'Not Found');
    }
  });

  // Keep-alive: ping every connection; drop ones that stop answering.
  const pingTimer = setInterval(() => {
    for (const wss of [teacherWss, deviceWss]) {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
    hub.sweepStaleDevices();
    hub.endExpiredLessons();
  }, 15_000);
  server.on('close', () => clearInterval(pingTimer));

  return { server, store, hub };
}

// Run directly: `node src/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let password = process.env.TEACHER_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log(`\nNo TEACHER_PASSWORD set. Temporary password for this run: ${password}\n`);
  }
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp({
    password,
    dataDir: process.env.DATA_DIR || path.join(here, '..', 'data'),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    lessonMaxMinutes: Number(process.env.LESSON_MAX_MINUTES) || 120,
  });
  server.listen(port, () => console.log(`Classroom hub listening on http://localhost:${port}`));
}
