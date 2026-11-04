// The "live" part of the system: which tablets are connected, what lesson is
// running, which links have been sent, and pushing updates to dashboards.
//
// Everything in this file lives in memory only. When a lesson ends its links
// and pupil activity are forgotten. Nothing about what pupils were doing is
// written to disk.

import crypto from 'node:crypto';
import { domainMatches, normaliseDomain, normaliseDomainList, normalisePackageList, normaliseLink } from './domains.js';

// A tablet sends a status report every ~15 s. If we hear nothing for this
// long we treat it as disconnected (Wi-Fi lost, asleep, app killed...).
export const DEVICE_TIMEOUT_MS = 45_000;

const DEVICE_STATES = new Set(['on', 'off', 'idle', 'unknown', 'paused']);
const LINK_STAGES = ['sent', 'delivered', 'opened'];

function cleanString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export class Hub {
  constructor(store, audit = () => {}) {
    this.store = store;
    this.audit = audit;
    this.lessons = new Map(); // classId -> lesson
    this.devices = new Map(); // pupilId -> { ws, lastMessageAt }
    this.live = new Map(); // pupilId -> latest report from the tablet
    this.lastSeen = new Map(); // pupilId -> timestamp (memory only)
    this.teachers = new Set(); // { ws, classId }
    this.pendingBroadcast = new Set();
    this.broadcastTimer = null;
  }

  // ---- Lessons -----------------------------------------------------------

  startLesson(classId, { allowedDomains = [], allowedApps = [] } = {}) {
    const cls = this.store.getClass(classId);
    if (!cls) throw new Error('Class not found');
    const lesson = {
      classId,
      startedAt: Date.now(),
      allowedDomains: normaliseDomainList(allowedDomains),
      allowedApps: normalisePackageList(allowedApps),
      links: [],
    };
    this.lessons.set(classId, lesson);
    this.audit('lesson.start', { classId, className: cls.name, allowedDomains: lesson.allowedDomains });
    this.pushLessonToClass(classId);
    return lesson;
  }

  endLesson(classId) {
    if (!this.lessons.has(classId)) return;
    this.lessons.delete(classId);
    this.audit('lesson.end', { classId });
    // Forget everything pupils in this class were doing.
    const cls = this.store.getClass(classId);
    for (const pupilId of cls ? cls.pupilIds : []) {
      if (!this.lessonForPupil(pupilId)) this.live.delete(pupilId);
    }
    this.pushLessonToClass(classId);
  }

  updateAllowed(classId, { allowedDomains, allowedApps }) {
    const lesson = this.lessons.get(classId);
    if (!lesson) throw new Error('No lesson running');
    if (allowedDomains) lesson.allowedDomains = normaliseDomainList(allowedDomains);
    if (allowedApps) lesson.allowedApps = normalisePackageList(allowedApps);
    this.audit('lesson.allowed', { classId, allowedDomains: lesson.allowedDomains, allowedApps: lesson.allowedApps });
    this.pushLessonToClass(classId);
    return lesson;
  }

  // If a pupil is in more than one running lesson, the most recent wins.
  lessonForPupil(pupilId) {
    let best = null;
    for (const classId of this.store.classIdsForPupil(pupilId)) {
      const lesson = this.lessons.get(classId);
      if (lesson && (!best || lesson.startedAt > best.startedAt)) best = lesson;
    }
    return best;
  }

  lessonMessageFor(pupilId) {
    const lesson = this.lessonForPupil(pupilId);
    if (!lesson) return { type: 'lesson', active: false };
    const cls = this.store.getClass(lesson.classId);
    return {
      type: 'lesson',
      active: true,
      className: cls ? cls.name : '',
      allowedDomains: lesson.allowedDomains,
      allowedApps: lesson.allowedApps,
    };
  }

  pushLessonToClass(classId) {
    const cls = this.store.getClass(classId);
    if (!cls) return;
    for (const pupilId of cls.pupilIds) {
      this.sendToDevice(pupilId, this.lessonMessageFor(pupilId));
      this.deliverPendingLinks(pupilId);
    }
    this.scheduleBroadcast(classId);
  }

  // ---- Links -------------------------------------------------------------

  // Sends a link to some or all pupils in a class. The link's site is added
  // to the allowed list automatically, so opening it counts as "on task".
  sendLink(classId, { url, pupilIds }) {
    const lesson = this.lessons.get(classId);
    if (!lesson) throw new Error('Start a lesson before sending links');
    const cls = this.store.getClass(classId);
    const clean = normaliseLink(url);
    if (!clean) throw new Error('That does not look like a web address');
    const targets = Array.isArray(pupilIds) && pupilIds.length
      ? pupilIds.filter((id) => cls.pupilIds.includes(id))
      : [...cls.pupilIds];
    if (!targets.length) throw new Error('No pupils selected');

    const domain = normaliseDomain(new URL(clean).hostname);
    if (domain && !domainMatches(domain, lesson.allowedDomains)) {
      lesson.allowedDomains.push(domain);
    }

    const link = {
      id: crypto.randomBytes(6).toString('hex'),
      url: clean,
      sentAt: Date.now(),
      targets: Object.fromEntries(targets.map((id) => [id, 'sent'])),
    };
    lesson.links.push(link);
    this.audit('link.send', { classId, url: clean, pupilCount: targets.length });

    this.pushLessonToClass(classId); // pushes new allowed list + the link itself
    return link;
  }

  deliverPendingLinks(pupilId) {
    const lesson = this.lessonForPupil(pupilId);
    if (!lesson || !this.devices.has(pupilId)) return;
    for (const link of lesson.links) {
      if (link.targets[pupilId] === 'sent') {
        this.sendToDevice(pupilId, { type: 'link', id: link.id, url: link.url });
      }
    }
  }

  recordLinkAck(pupilId, linkId, stage) {
    if (!LINK_STAGES.includes(stage)) return;
    const lesson = this.lessonForPupil(pupilId);
    const link = lesson && lesson.links.find((l) => l.id === linkId);
    if (!link || !(pupilId in link.targets)) return;
    // Stages only move forward: sent -> delivered -> opened.
    if (LINK_STAGES.indexOf(stage) > LINK_STAGES.indexOf(link.targets[pupilId])) {
      link.targets[pupilId] = stage;
      this.scheduleBroadcastForPupil(pupilId);
    }
  }

  // ---- Tablets -----------------------------------------------------------

  attachDevice(pupil, ws) {
    const existing = this.devices.get(pupil.id);
    if (existing && existing.ws !== ws) existing.ws.close(4000, 'Replaced by a newer connection');
    this.devices.set(pupil.id, { ws, lastMessageAt: Date.now() });
    this.lastSeen.set(pupil.id, Date.now());

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleDeviceMessage(pupil.id, msg);
    });
    ws.on('close', () => {
      const current = this.devices.get(pupil.id);
      if (current && current.ws === ws) {
        this.devices.delete(pupil.id);
        this.scheduleBroadcastForPupil(pupil.id);
      }
    });

    this.sendToDevice(pupil.id, { type: 'welcome', pupilName: pupil.name, serverTime: Date.now() });
    this.sendToDevice(pupil.id, this.lessonMessageFor(pupil.id));
    this.deliverPendingLinks(pupil.id);
    this.scheduleBroadcastForPupil(pupil.id);
  }

  handleDeviceMessage(pupilId, msg) {
    const device = this.devices.get(pupilId);
    if (device) device.lastMessageAt = Date.now();
    this.lastSeen.set(pupilId, Date.now());
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'status') {
      const lesson = this.lessonForPupil(pupilId);
      const report = {
        state: DEVICE_STATES.has(msg.state) ? msg.state : 'unknown',
        screenOn: msg.screenOn !== false,
        appLabel: cleanString(msg.appLabel, 60),
        // Package name only when off task, so the teacher can "allow this app".
        appPackage: msg.state === 'off' ? normalisePackageList([msg.appPackage])[0] || null : null,
        // The tablet only sends a domain when the pupil is off task.
        domain: msg.state === 'off' ? normaliseDomain(msg.domain || '') : null,
        matched: cleanString(msg.matched, 120),
        detail: cleanString(msg.detail, 120),
        perms: {
          usage: !!(msg.perms && msg.perms.usage),
          website: !!(msg.perms && msg.perms.website),
        },
        battery: Number.isFinite(msg.battery) ? Math.max(0, Math.min(100, Math.round(msg.battery))) : null,
        appVersion: cleanString(msg.appVersion, 20),
        at: Date.now(),
      };
      // Outside a lesson we keep nothing but "connected".
      if (lesson) this.live.set(pupilId, report);
      else this.live.set(pupilId, { ...report, state: 'paused', appLabel: null, appPackage: null, domain: null, matched: null, detail: null });
      this.scheduleBroadcastForPupil(pupilId);
    } else if (msg.type === 'linkAck') {
      this.recordLinkAck(pupilId, cleanString(msg.id, 40), msg.stage);
    }
  }

  sendToDevice(pupilId, message) {
    const device = this.devices.get(pupilId);
    if (device && device.ws.readyState === 1) device.ws.send(JSON.stringify(message));
  }

  // Called on a timer: drop tablets we have not heard from recently.
  sweepStaleDevices(now = Date.now()) {
    for (const [pupilId, device] of this.devices) {
      if (now - device.lastMessageAt > DEVICE_TIMEOUT_MS) {
        device.ws.terminate();
        this.devices.delete(pupilId);
        this.scheduleBroadcastForPupil(pupilId);
      }
    }
  }

  // ---- Teacher dashboards -------------------------------------------------

  attachTeacher(ws) {
    const entry = { ws, classId: null };
    this.teachers.add(entry);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === 'watch' && typeof msg.classId === 'string') {
        entry.classId = msg.classId;
        this.sendClassState(entry);
      }
    });
    ws.on('close', () => this.teachers.delete(entry));
  }

  pupilView(pupilId, lesson) {
    const pupil = this.store.getPupil(pupilId);
    const connected = this.devices.has(pupilId);
    const report = this.live.get(pupilId);
    const view = {
      id: pupilId,
      name: pupil ? pupil.name : '(removed pupil)',
      paired: this.store.isPupilPaired(pupilId),
      connected,
      lastSeen: this.lastSeen.get(pupilId) || null,
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
      if (!lesson) view.status = 'connected';
      else if (!report) view.status = 'unknown';
      else if (!report.screenOn) view.status = 'asleep';
      else {
        view.status = report.state === 'paused' ? 'unknown' : report.state;
        view.appLabel = report.appLabel;
        view.appPackage = report.appPackage;
        view.domain = report.domain;
        view.matched = report.matched;
        view.detail = report.detail;
      }
    }
    if (lesson) {
      for (const link of lesson.links) {
        if (pupilId in link.targets) view.links[link.id] = link.targets[pupilId];
      }
    }
    return view;
  }

  classState(classId) {
    const cls = this.store.getClass(classId);
    if (!cls) return { type: 'classState', classId, missing: true };
    const lesson = this.lessons.get(classId) || null;
    const pupils = cls.pupilIds.map((id) => this.pupilView(id, lesson));
    pupils.sort((a, b) => a.name.localeCompare(b.name));
    const counts = {};
    for (const p of pupils) counts[p.status] = (counts[p.status] || 0) + 1;
    return {
      type: 'classState',
      classId,
      className: cls.name,
      lesson: lesson && {
        startedAt: lesson.startedAt,
        allowedDomains: lesson.allowedDomains,
        allowedApps: lesson.allowedApps,
        links: lesson.links.map((l) => ({ id: l.id, url: l.url, sentAt: l.sentAt })),
      },
      pupils,
      counts,
      serverTime: Date.now(),
    };
  }

  sendClassState(entry) {
    if (!entry.classId || entry.ws.readyState !== 1) return;
    entry.ws.send(JSON.stringify(this.classState(entry.classId)));
  }

  scheduleBroadcastForPupil(pupilId) {
    for (const classId of this.store.classIdsForPupil(pupilId)) this.scheduleBroadcast(classId);
  }

  // Batches updates so 30 tablets reporting at once cause one redraw, not 30.
  scheduleBroadcast(classId) {
    this.pendingBroadcast.add(classId);
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const classIds = [...this.pendingBroadcast];
      this.pendingBroadcast.clear();
      for (const entry of this.teachers) {
        if (classIds.includes(entry.classId)) this.sendClassState(entry);
      }
    }, 250);
  }
}
