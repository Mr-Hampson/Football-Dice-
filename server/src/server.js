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
//   TRUST_PROXY       set to "true" when running behind a hosting proxy (Render)
//   APP_DOWNLOAD_URL  where /app sends tablets to download the pupil app
//   AUDIT_RETENTION_DAYS  audit log entries older than this are deleted (default 120)
//   AUDIT_KEY         if set, audit log entries are encrypted on disk with it
//   TEACHER_ALLOWED_IPS  optional: dashboard only from these IPs/ranges, e.g. 203.0.113.7,198.51.100.0/24

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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
  auditKey: auditKeyInput = null,
  teacherAllowedIps = '',
  lessonMaxMinutes = 120,
  auditRetentionDays = 120,
  deviceConfig = {},
  trustProxy = false,
  appDownloadUrl = 'https://github.com/Mr-Hampson/Football-Dice-/releases/latest/download/classroom-hub.apk',
  releasesApi = 'https://api.github.com/repos/Mr-Hampson/Football-Dice-/releases/latest',
  log = console.log,
} = {}) {
  if (!password) throw new Error('A teacher password is required');
  const store = new Store(dataDir ? path.join(dataDir, 'store.json') : null);

  // The audit log records what teachers DO (start lessons, send links),
  // never what pupils do.
  const auditPath = dataDir ? path.join(dataDir, 'audit.log') : null;
  // Audit entries are encrypted on disk (AES-256-GCM) when AUDIT_KEY is set,
  // so a leaked disk or backup can't be read. Note: the key lives with the
  // hub's other settings, so this does not protect against a compromised
  // hosting account. Older unencrypted lines are still read.
  const auditKey = auditKeyInput ? crypto.createHash('sha256').update(String(auditKeyInput)).digest() : null;
  function encodeAudit(entry) {
    const json = JSON.stringify(entry);
    if (!auditKey) return json;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', auditKey, iv);
    const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
  }
  function decodeAudit(line) {
    if (!line.startsWith('enc1:')) return JSON.parse(line);
    if (!auditKey) return null;
    const buf = Buffer.from(line.slice(5), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', auditKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }

  const audit = (action, details = {}) => {
    if (!auditPath) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditPath, `${encodeAudit({ at: new Date().toISOString(), action, ...details })}\n`);
  };

  // Keep the audit log for a fixed period only, then delete old entries.
  function readAudit() {
    if (!auditPath || !fs.existsSync(auditPath)) return [];
    return fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return decodeAudit(line); } catch { return null; }
    }).filter(Boolean);
  }
  function pruneAudit(now = Date.now()) {
    if (!auditPath || !fs.existsSync(auditPath)) return 0;
    const cutoff = now - auditRetentionDays * 24 * 60 * 60 * 1000;
    const all = readAudit();
    const keep = all.filter((e) => Date.parse(e.at) >= cutoff);
    if (keep.length === all.length) return 0;
    const tmp = `${auditPath}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => encodeAudit(e)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, auditPath);
    return all.length - keep.length;
  }
  pruneAudit();

  // Newest pupil-app build, from the GitHub release tags ("test-build-12").
  // Cached so 30 tablets checking at once cause one lookup, not 30.
  let versionCache = { at: 0, value: { versionCode: 0, downloadUrl: appDownloadUrl } };
  async function latestAppVersion() {
    if (!releasesApi || Date.now() - versionCache.at < 10 * 60 * 1000) return versionCache.value;
    versionCache.at = Date.now();
    try {
      const r = await fetch(releasesApi, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'classroom-hub' } });
      if (r.ok) {
        const tag = String((await r.json()).tag_name || '');
        const n = Number((tag.match(/(\d+)$/) || [])[1]);
        if (Number.isFinite(n) && n > 0) versionCache.value = { versionCode: n, downloadUrl: appDownloadUrl };
      }
    } catch { /* keep the last known value */ }
    return versionCache.value;
  }

  const hub = new Hub(store, { audit, lessonMaxMs: lessonMaxMinutes * 60 * 1000, deviceConfig });
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

  // Behind a hosting service's proxy (e.g. Render), every request arrives
  // from the proxy, so use the address the proxy recorded instead. We take
  // the LAST X-Forwarded-For entry: the one the proxy itself added, which a
  // client cannot fake.
  // Optional: the dashboard only works from these addresses (e.g. the school's
  // public IP), so a leaked password is useless from outside school.
  // Tablets are never restricted. Entries: exact IPs or IPv4 ranges (a.b.c.0/24).
  const allowList = String(teacherAllowedIps || '').split(',').map((x) => x.trim()).filter(Boolean);
  function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    return parts.length === 4 && parts.every((n) => n >= 0 && n <= 255) ? parts.reduce((a, n) => (a << 8) + n, 0) >>> 0 : null;
  }
  function teacherIpAllowed(req) {
    if (!allowList.length) return true;
    const ip = clientIp(req).replace(/^::ffff:/, '');
    return allowList.some((entry) => {
      if (!entry.includes('/')) return entry === ip;
      const [base, bits] = entry.split('/');
      const a = ipv4ToInt(ip), b = ipv4ToInt(base), n = Number(bits);
      if (a == null || b == null || !(n >= 0 && n <= 32)) return false;
      const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
      return (a & mask) === (b & mask);
    });
  }

  function clientIp(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // Sent with every reply. HSTS tells browsers to only ever use HTTPS here.
  function securityHeaders() {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...(cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    };
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    let payload = Buffer.from(isJson ? JSON.stringify(body) : body);
    const extra = {};
    // Compress bigger replies (e.g. the dashboard's fallback refresh) to keep
    // data use, and hosting costs, down.
    const accepts = String((res.req && res.req.headers['accept-encoding']) || '');
    if (payload.length > 1024 && /\bgzip\b/.test(accepts)) {
      payload = zlib.gzipSync(payload);
      extra['Content-Encoding'] = 'gzip';
      extra.Vary = 'Accept-Encoding';
    }
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...securityHeaders(),
      ...extra,
      ...headers,
    });
    res.end(payload);
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
      ...securityHeaders(),
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
    // Same data the dashboard normally gets over its live connection. Used
    // as a fallback when a network blocks WebSockets.
    ['GET', /^\/api\/state$/, true, async (req, res) => {
      const lessonId = new URL(req.url, 'http://localhost').searchParams.get('lessonId');
      return send(res, 200, hub.lessonState(lessonId && /^[a-f0-9]{16}$/.test(lessonId) ? lessonId : null));
    }],
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
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/messages$/, true, async (req, res, [lessonId]) => {
      const m = hub.sendMessage(lessonId, await readJson(req));
      return send(res, 201, { id: m.id });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/help\/clear$/, true, async (req, res, [lessonId]) => {
      hub.clearHelp(lessonId, (await readJson(req)).tabletIds);
      return send(res, 200, { ok: true });
    }],
    ['GET', /^\/api\/audit$/, true, async (req, res) => {
      const entries = readAudit().slice(-500).reverse();
      return send(res, 200, { retentionDays: auditRetentionDays, entries });
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/freeze$/, true, async (req, res, [lessonId]) => {
      return send(res, 200, hub.freeze(lessonId, await readJson(req)));
    }],
    ['POST', /^\/api\/lessons\/([a-f0-9]+)\/unfreeze$/, true, async (req, res, [lessonId]) => {
      hub.unfreeze(lessonId, await readJson(req));
      return send(res, 200, { ok: true });
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
    ['GET', /^\/api\/tablets$/, true, async (req, res) => {
      const latest = await latestAppVersion();
      return send(res, 200, { latestVersionCode: latest.versionCode, tablets: hub.tabletsOverview(latest.versionCode) });
    }],
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

    // Tablets ask which app version is newest, to offer an update.
    ['GET', /^\/api\/app-version$/, false, async (req, res) => send(res, 200, await latestAppVersion())],

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
          const teacherRoute = needsTeacher || /^\/api\/(login|logout|me)$/.test(pathname);
          if (teacherRoute && !teacherIpAllowed(req)) {
            return send(res, 403, { error: 'The teacher dashboard only works on the school network.' });
          }
          if (needsTeacher && !isTeacher(req)) return send(res, 401, { error: 'Please log in' });
          return await handler(req, res, match.slice(1));
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (pathname === '/healthz') return send(res, 200, 'ok');
      // Short, easy-to-type install link for tablets: /app forwards to the
      // newest build of the pupil app.
      if (pathname === '/app' || pathname === '/app/') {
        res.writeHead(302, { Location: appDownloadUrl, 'Cache-Control': 'no-store', ...securityHeaders() });
        return res.end();
      }
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return send(res, 405, 'Method not allowed');
    } catch (err) {
      const status = err.status || 400;
      if (status >= 500) log(err);
      return send(res, status, { error: err.message || 'Something went wrong' });
    }
  });

  // ---- WebSockets --------------------------------------------------------

  // perMessageDeflate compresses live updates, which cuts data use a lot.
  const compression = { threshold: 512 };
  const teacherWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: compression });
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: compression });

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
      if (!teacherIpAllowed(req)) return reject(403, 'Forbidden');
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

  let lastPrune = Date.now();

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
    if (Date.now() - lastPrune > 24 * 60 * 60 * 1000) {
      lastPrune = Date.now();
      pruneAudit();
    }
  }, 15_000);
  server.on('close', () => clearInterval(pingTimer));

  return { server, store, hub, pruneAudit };
}

// Settings for the tablets, from config/device-config.json.
function loadDeviceConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'device-config.json'), 'utf8'));
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 200).slice(0, 30) : []);
    return { urlBarIds: list(raw.urlBarIds), urlHints: list(raw.urlHints) };
  } catch {
    return {};
  }
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
    auditKey: process.env.AUDIT_KEY || null,
    teacherAllowedIps: process.env.TEACHER_ALLOWED_IPS || '',
    lessonMaxMinutes: Number(process.env.LESSON_MAX_MINUTES) || 120,
    trustProxy: process.env.TRUST_PROXY === 'true',
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS) || 120,
    deviceConfig: loadDeviceConfig(),
    appDownloadUrl: process.env.APP_DOWNLOAD_URL || undefined,
    releasesApi: process.env.APP_RELEASES_API || undefined,
  });
  server.listen(port, () => {
    console.log(`\nClassroom Hub is running.`);
    console.log(`  Teacher dashboard (this computer):  http://localhost:${port}`);
    // Addresses other devices on the same Wi-Fi can use, e.g. for testing a tablet at home.
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a.address}:${port}`);
    for (const url of lan) console.log(`  Hub address for tablets on this Wi-Fi: ${url}`);
    console.log('\nLeave this window open while you use the hub. Press Ctrl+C to stop it.\n');
  });
}
