// The "live" part of the system: running lessons, which tablets are
// connected, who has joined which lesson, links sent, and pushing updates to
// teacher dashboards.
//
// Everything in this file lives in memory only. When a lesson ends, its
// pupil names, links and activity are forgotten. Nothing about pupils is
// written to disk.

import crypto from 'node:crypto';
import { randomCode, normaliseCode } from './store.js';
import { normalisePupilName, NAME_RULE } from './names.js';
import { domainMatches, normaliseDomain, normaliseDomainList, normalisePackageList, normaliseLink } from './domains.js';

// A tablet reports every ~15 s at least. Silence for this long = disconnected.
export const DEVICE_TIMEOUT_MS = 45_000;
const JOIN_CODE_LENGTH = 4;
const MAX_JOIN_FAILURES = 10; // per tablet, per lesson-code guessing window
const JOIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;

const DEVICE_STATES = new Set(['on', 'off', 'idle', 'unknown', 'paused']);
const LINK_STAGES = ['sent', 'delivered', 'opened'];

function cleanString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export class Hub {
  constructor(store, { audit = () => {}, lessonMaxMs = 2 * 60 * 60 * 1000 } = {}) {
    this.store = store;
    this.audit = audit;
    this.lessonMaxMs = lessonMaxMs;
    this.lessons = new Map(); // lessonId -> lesson
    this.devices = new Map(); // tabletId -> { ws, lastMessageAt }
    this.lastSeen = new Map(); // tabletId -> timestamp (memory only)
    this.live = new Map(); // tabletId -> latest status report
    this.tabletLesson = new Map(); // tabletId -> lessonId
    this.joinFailures = new Map(); // tabletId -> { count, resetAt }
    this.teachers = new Set(); // { ws, lessonId }
    this.pendingBroadcast = new Set();
    this.broadcastTimer = null;
  }

  // ---- Lessons ---------------------------------------------------------------

  startLesson({ title = '', allowedDomains = [], allowedApps = [] } = {}) {
    let joinCode;
    do joinCode = randomCode(JOIN_CODE_LENGTH);
    while ([...this.lessons.values()].some((l) => l.joinCode === joinCode));
    const now = Date.now();
    const lesson = {
      id: crypto.randomBytes(8).toString('hex'),
      joinCode,
      title: String(title).trim().slice(0, 60) || 'Lesson',
      startedAt: now,
      endsAt: now + this.lessonMaxMs,
      allowedDomains: normaliseDomainList(allowedDomains),
      allowedApps: normalisePackageList(allowedApps),
      links: [],
      participants: new Map(), // tabletId -> { name, joinedAt, nameRequested }
    };
    this.lessons.set(lesson.id, lesson);
    this.audit('lesson.start', { lessonId: lesson.id, title: lesson.title, allowedDomains: lesson.allowedDomains });
    this.broadcastAll(); // other dashboards' "running lessons" lists
    return lesson;
  }

  getLesson(lessonId) {
    const lesson = this.lessons.get(lessonId);
    if (!lesson) throw Object.assign(new Error('That lesson has ended'), { status: 404 });
    return lesson;
  }

  listLessons() {
    return [...this.lessons.values()].map((l) => ({
      id: l.id,
      title: l.title,
      joinCode: l.joinCode,
      startedAt: l.startedAt,
      endsAt: l.endsAt,
      pupilCount: l.participants.size,
    }));
  }

  endLesson(lessonId, reason = 'teacher') {
    const lesson = this.lessons.get(lessonId);
    if (!lesson) return;
    this.lessons.delete(lessonId);
    this.audit('lesson.end', { lessonId, reason });
    for (const tabletId of lesson.participants.keys()) {
      this.tabletLesson.delete(tabletId);
      this.live.delete(tabletId); // forget what they were doing
      this.sendLessonState(tabletId);
    }
    this.broadcastAll();
  }

  endExpiredLessons(now = Date.now()) {
    for (const lesson of [...this.lessons.values()]) {
      if (now > lesson.endsAt) this.endLesson(lesson.id, 'time limit');
    }
  }

  updateAllowed(lessonId, { allowedDomains, allowedApps }) {
    const lesson = this.getLesson(lessonId);
    if (allowedDomains) lesson.allowedDomains = normaliseDomainList(allowedDomains);
    if (allowedApps) lesson.allowedApps = normalisePackageList(allowedApps);
    this.audit('lesson.allowed', { lessonId, allowedDomains: lesson.allowedDomains, allowedApps: lesson.allowedApps });
    this.pushLessonToParticipants(lesson);
    return lesson;
  }

  pushLessonToParticipants(lesson) {
    for (const tabletId of lesson.participants.keys()) this.sendLessonState(tabletId);
    this.scheduleBroadcast(lesson.id);
  }

  // ---- Joining ---------------------------------------------------------------

  joinFailed(tabletId) {
    const now = Date.now();
    let entry = this.joinFailures.get(tabletId);
    if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + JOIN_FAILURE_WINDOW_MS };
    entry.count += 1;
    this.joinFailures.set(tabletId, entry);
  }

  joinBlocked(tabletId) {
    const entry = this.joinFailures.get(tabletId);
    return !!entry && Date.now() <= entry.resetAt && entry.count >= MAX_JOIN_FAILURES;
  }

  // A pupil types the join code and their name on a tablet.
  join(tabletId, codeInput, nameInput) {
    if (this.joinBlocked(tabletId)) return { error: 'Too many wrong codes. Wait a few minutes.' };
    const code = normaliseCode(codeInput);
    const lesson = [...this.lessons.values()].find((l) => l.joinCode === code);
    if (!lesson) {
      this.joinFailed(tabletId);
      return { error: 'Join code not recognised. Check the code on the board.' };
    }
    const name = normalisePupilName(nameInput);
    if (!name) return { error: NAME_RULE };

    // Moving from another lesson? Leave it first.
    const previous = this.tabletLesson.get(tabletId);
    if (previous && previous !== lesson.id) this.removeFromLesson(previous, tabletId, false);

    lesson.participants.set(tabletId, { name, joinedAt: Date.now(), nameRequested: false });
    this.tabletLesson.set(tabletId, lesson.id);
    this.live.delete(tabletId);
    this.sendLessonState(tabletId);
    this.deliverPendingLinks(tabletId);
    this.broadcastAll(); // unjoined-tablet lists and pupil counts change
    return { lesson, name };
  }

  // The pupil retyped their name after the teacher asked them to.
  rename(tabletId, nameInput) {
    const lesson = this.lessonForTablet(tabletId);
    if (!lesson) return { error: 'Not in a lesson' };
    const name = normalisePupilName(nameInput);
    if (!name) return { error: NAME_RULE };
    const p = lesson.participants.get(tabletId);
    p.name = name;
    p.nameRequested = false;
    this.sendLessonState(tabletId);
    this.scheduleBroadcast(lesson.id);
    return { name };
  }

  requestRename(lessonId, tabletIds) {
    const lesson = this.getLesson(lessonId);
    for (const id of tabletIds || []) {
      const p = lesson.participants.get(id);
      if (!p) continue;
      p.nameRequested = true;
      this.sendLessonState(id);
    }
    this.scheduleBroadcast(lessonId);
  }

  removeFromLesson(lessonId, tabletId, notify = true) {
    const lesson = this.lessons.get(lessonId);
    if (!lesson || !lesson.participants.delete(tabletId)) return;
    this.tabletLesson.delete(tabletId);
    this.live.delete(tabletId);
    if (notify) this.sendLessonState(tabletId);
    this.broadcastAll();
  }

  removeMany(lessonId, tabletIds) {
    this.getLesson(lessonId);
    for (const id of tabletIds || []) this.removeFromLesson(lessonId, id);
    this.audit('lesson.remove', { lessonId, count: (tabletIds || []).length });
  }

  lessonForTablet(tabletId) {
    const lessonId = this.tabletLesson.get(tabletId);
    return lessonId ? this.lessons.get(lessonId) || null : null;
  }

  // What the tablet needs to know: are we in a lesson, its rules, our name.
  sendLessonState(tabletId) {
    const lesson = this.lessonForTablet(tabletId);
    if (!lesson) return this.sendToDevice(tabletId, { type: 'lesson', active: false });
    const p = lesson.participants.get(tabletId);
    this.sendToDevice(tabletId, {
      type: 'lesson',
      active: true,
      title: lesson.title,
      name: p.name,
      nameRequested: p.nameRequested,
      allowedDomains: lesson.allowedDomains,
      allowedApps: lesson.allowedApps,
    });
  }

  // ---- Links -----------------------------------------------------------------

  // Sends a link to some or all pupils in a lesson. Its site is added to the
  // allowed list automatically, so opening it counts as "on task".
  sendLink(lessonId, { url, tabletIds }) {
    const lesson = this.getLesson(lessonId);
    const clean = normaliseLink(url);
    if (!clean) throw new Error('That does not look like a web address');
    const targets = Array.isArray(tabletIds) && tabletIds.length
      ? tabletIds.filter((id) => lesson.participants.has(id))
      : [...lesson.participants.keys()];
    if (!targets.length) throw new Error('No pupils have joined yet');

    const domain = normaliseDomain(new URL(clean).hostname);
    if (domain && !domainMatches(domain, lesson.allowedDomains)) lesson.allowedDomains.push(domain);

    const link = {
      id: crypto.randomBytes(6).toString('hex'),
      url: clean,
      sentAt: Date.now(),
      targets: Object.fromEntries(targets.map((id) => [id, 'sent'])),
    };
    lesson.links.push(link);
    this.audit('link.send', { lessonId, url: clean, pupilCount: targets.length });
    this.pushLessonToParticipants(lesson); // new allowed list
    for (const id of targets) this.deliverPendingLinks(id);
    return link;
  }

  deliverPendingLinks(tabletId) {
    const lesson = this.lessonForTablet(tabletId);
    if (!lesson || !this.devices.has(tabletId)) return;
    for (const link of lesson.links) {
      if (link.targets[tabletId] === 'sent') {
        this.sendToDevice(tabletId, { type: 'link', id: link.id, url: link.url });
      }
    }
  }

  recordLinkAck(tabletId, linkId, stage) {
    if (!LINK_STAGES.includes(stage)) return;
    const lesson = this.lessonForTablet(tabletId);
    const link = lesson && lesson.links.find((l) => l.id === linkId);
    if (!link || !(tabletId in link.targets)) return;
    // Stages only move forward: sent -> delivered -> opened.
    if (LINK_STAGES.indexOf(stage) > LINK_STAGES.indexOf(link.targets[tabletId])) {
      link.targets[tabletId] = stage;
      this.scheduleBroadcast(lesson.id);
    }
  }

  // ---- Tablets ---------------------------------------------------------------

  attachDevice(tablet, ws) {
    const existing = this.devices.get(tablet.id);
    if (existing && existing.ws !== ws) existing.ws.close(4000, 'Replaced by a newer connection');
    this.devices.set(tablet.id, { ws, lastMessageAt: Date.now() });
    this.lastSeen.set(tablet.id, Date.now());

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleDeviceMessage(tablet.id, msg);
    });
    ws.on('close', () => {
      const current = this.devices.get(tablet.id);
      if (current && current.ws === ws) {
        this.devices.delete(tablet.id);
        this.broadcastAll();
      }
    });

    this.sendToDevice(tablet.id, { type: 'welcome', tabletNumber: tablet.number, serverTime: Date.now() });
    this.sendLessonState(tablet.id);
    this.deliverPendingLinks(tablet.id);
    this.broadcastAll();
  }

  // Called when a tablet is removed on the Tablets page.
  forgetTablet(tabletId) {
    const lessonId = this.tabletLesson.get(tabletId);
    if (lessonId) this.removeFromLesson(lessonId, tabletId, false);
    const device = this.devices.get(tabletId);
    if (device) device.ws.close(4001, 'Tablet removed');
    this.devices.delete(tabletId);
    this.broadcastAll();
  }

  handleDeviceMessage(tabletId, msg) {
    const device = this.devices.get(tabletId);
    if (device) device.lastMessageAt = Date.now();
    this.lastSeen.set(tabletId, Date.now());
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'join': {
        const result = this.join(tabletId, msg.code, msg.name);
        if (result.error) this.sendToDevice(tabletId, { type: 'joinError', error: result.error });
        break;
      }
      case 'rename': {
        const result = this.rename(tabletId, msg.name);
        if (result.error) this.sendToDevice(tabletId, { type: 'joinError', error: result.error });
        break;
      }
      case 'status':
        this.recordStatus(tabletId, msg);
        break;
      case 'linkAck':
        this.recordLinkAck(tabletId, cleanString(msg.id, 40), msg.stage);
        break;
      default:
    }
  }

  recordStatus(tabletId, msg) {
    const lesson = this.lessonForTablet(tabletId);
    // Outside a lesson we keep nothing about what the tablet is doing.
    if (!lesson) {
      this.live.delete(tabletId);
      return;
    }
    const off = msg.state === 'off';
    this.live.set(tabletId, {
      state: DEVICE_STATES.has(msg.state) ? msg.state : 'unknown',
      screenOn: msg.screenOn !== false,
      appLabel: cleanString(msg.appLabel, 60),
      // Site and package are only sent when the pupil is off task.
      appPackage: off ? normalisePackageList([msg.appPackage])[0] || null : null,
      domain: off ? normaliseDomain(msg.domain || '') : null,
      matched: cleanString(msg.matched, 120),
      detail: cleanString(msg.detail, 120),
      perms: {
        usage: !!(msg.perms && msg.perms.usage),
        website: !!(msg.perms && msg.perms.website),
      },
      battery: Number.isFinite(msg.battery) ? Math.max(0, Math.min(100, Math.round(msg.battery))) : null,
      at: Date.now(),
    });
    this.scheduleBroadcast(lesson.id);
  }

  sendToDevice(tabletId, message) {
    const device = this.devices.get(tabletId);
    if (device && device.ws.readyState === 1) device.ws.send(JSON.stringify(message));
  }

  // Called on a timer: drop tablets we have not heard from recently.
  sweepStaleDevices(now = Date.now()) {
    for (const [tabletId, device] of this.devices) {
      if (now - device.lastMessageAt > DEVICE_TIMEOUT_MS) {
        device.ws.terminate();
        this.devices.delete(tabletId);
        this.broadcastAll();
      }
    }
  }

  // Tablets that are switched on and connected but not in any lesson.
  // Shown on every dashboard, so a pupil who never joined can be spotted.
  unjoinedTablets() {
    const out = [];
    for (const tabletId of this.devices.keys()) {
      if (this.tabletLesson.has(tabletId)) continue;
      const tablet = this.store.getTablet(tabletId);
      if (tablet) out.push(tablet.number);
    }
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  tabletsOverview() {
    return this.store.listTablets().map((t) => {
      const lesson = this.lessonForTablet(t.id);
      return {
        id: t.id,
        number: t.number,
        connected: this.devices.has(t.id),
        lastSeen: this.lastSeen.get(t.id) || null,
        lessonTitle: lesson ? lesson.title : null,
        enrolledAt: t.enrolledAt,
      };
    });
  }

  // ---- Teacher dashboards ----------------------------------------------------

  attachTeacher(ws) {
    const entry = { ws, lessonId: null };
    this.teachers.add(entry);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === 'watch') {
        entry.lessonId = typeof msg.lessonId === 'string' ? msg.lessonId : null;
        this.sendLessonState2Teacher(entry);
      }
    });
    ws.on('close', () => this.teachers.delete(entry));
  }

  pupilView(lesson, tabletId, participant, nameCounts) {
    const tablet = this.store.getTablet(tabletId);
    const connected = this.devices.has(tabletId);
    const report = this.live.get(tabletId);
    const view = {
      id: tabletId,
      name: participant.name,
      tabletNumber: tablet ? tablet.number : '?',
      duplicateName: nameCounts.get(participant.name.toLowerCase()) > 1,
      nameRequested: participant.nameRequested,
      connected,
      lastSeen: this.lastSeen.get(tabletId) || null,
      status: 'offline',
      appLabel: null,
      appPackage: null,
      domain: null,
      matched: null,
      detail: null,
      perms: report ? report.perms : null,
      battery: report ? report.battery : null,
      links: {},
    };
    if (connected) {
      if (!report) view.status = 'unknown';
      else if (!report.screenOn) view.status = 'asleep';
      else {
        view.status = report.state === 'paused' ? 'unknown' : report.state;
        Object.assign(view, {
          appLabel: report.appLabel,
          appPackage: report.appPackage,
          domain: report.domain,
          matched: report.matched,
          detail: report.detail,
        });
      }
    }
    for (const link of lesson.links) {
      if (tabletId in link.targets) view.links[link.id] = link.targets[tabletId];
    }
    return view;
  }

  lessonState(lessonId) {
    const base = { type: 'lessonState', lessons: this.listLessons(), unjoinedTablets: this.unjoinedTablets() };
    const lesson = lessonId && this.lessons.get(lessonId);
    if (!lesson) return { ...base, lesson: null, lessonId, ended: !!lessonId };

    const nameCounts = new Map();
    for (const p of lesson.participants.values()) {
      const k = p.name.toLowerCase();
      nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
    }
    const pupils = [...lesson.participants].map(([id, p]) => this.pupilView(lesson, id, p, nameCounts));
    pupils.sort((a, b) => a.name.localeCompare(b.name) || a.tabletNumber.localeCompare(b.tabletNumber, undefined, { numeric: true }));
    return {
      ...base,
      lessonId,
      lesson: {
        id: lesson.id,
        title: lesson.title,
        joinCode: lesson.joinCode,
        startedAt: lesson.startedAt,
        endsAt: lesson.endsAt,
        allowedDomains: lesson.allowedDomains,
        allowedApps: lesson.allowedApps,
        links: lesson.links.map((l) => ({ id: l.id, url: l.url, sentAt: l.sentAt })),
      },
      pupils,
      serverTime: Date.now(),
    };
  }

  sendLessonState2Teacher(entry) {
    if (entry.ws.readyState !== 1) return;
    entry.ws.send(JSON.stringify(this.lessonState(entry.lessonId)));
  }

  // Batches updates so 30 tablets reporting at once cause one redraw, not 30.
  scheduleBroadcast(lessonId) {
    this.pendingBroadcast.add(lessonId);
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const all = this.pendingBroadcast.has('*');
      const ids = new Set(this.pendingBroadcast);
      this.pendingBroadcast.clear();
      for (const entry of this.teachers) {
        if (all || ids.has(entry.lessonId)) this.sendLessonState2Teacher(entry);
      }
    }, 250);
  }

  // Something every dashboard shows changed (running lessons, unjoined tablets).
  broadcastAll() {
    this.scheduleBroadcast('*');
  }
}
