// Persistent storage for the things that must survive a restart:
// classes, pupils, paired tablets and one-time pairing codes.
//
// Deliberately NOT stored here: what pupils are doing. Activity is kept in
// memory only (see hub.js) and disappears when a lesson ends or the server
// restarts. This is "data minimisation" by design and should make the DPIA
// simpler. Change this only after agreeing it with the Data Protection Officer.
//
// Storage is a single JSON file. That is fine for a one-school prototype and
// easy to inspect; swap for a real database (e.g. PostgreSQL) before scaling.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { pupils: [], classes: [], devices: [], pairingCodes: [] };

// Pairing codes avoid characters that are easy to confuse (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(EMPTY);
    if (filePath && fs.existsSync(filePath)) {
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    }
  }

  save() {
    if (!this.filePath) return; // in-memory mode (used by tests)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write to a temp file then rename, so a crash never leaves a half-written file.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ---- Classes and pupils -------------------------------------------------

  listClasses() {
    return this.data.classes.map((c) => ({ ...c, pupilCount: c.pupilIds.length }));
  }

  getClass(classId) {
    return this.data.classes.find((c) => c.id === classId) || null;
  }

  createClass(name) {
    const cls = { id: newId(), name: String(name).trim().slice(0, 80), pupilIds: [] };
    if (!cls.name) throw new Error('Class name is required');
    this.data.classes.push(cls);
    this.save();
    return cls;
  }

  deleteClass(classId) {
    this.data.classes = this.data.classes.filter((c) => c.id !== classId);
    this.save();
  }

  getPupil(pupilId) {
    return this.data.pupils.find((p) => p.id === pupilId) || null;
  }

  // Adds pupils to a class from a list of names. A name that already exists
  // (case-insensitive) is reused, so the same pupil can be in several classes.
  addPupilsToClass(classId, names) {
    const cls = this.getClass(classId);
    if (!cls) throw new Error('Class not found');
    const added = [];
    for (const raw of names) {
      const name = String(raw).trim().slice(0, 80);
      if (!name) continue;
      let pupil = this.data.pupils.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!pupil) {
        pupil = { id: newId(), name };
        this.data.pupils.push(pupil);
      }
      if (!cls.pupilIds.includes(pupil.id)) cls.pupilIds.push(pupil.id);
      added.push(pupil);
    }
    this.save();
    return added;
  }

  removePupilFromClass(classId, pupilId) {
    const cls = this.getClass(classId);
    if (!cls) return;
    cls.pupilIds = cls.pupilIds.filter((id) => id !== pupilId);
    this.save();
  }

  classIdsForPupil(pupilId) {
    return this.data.classes.filter((c) => c.pupilIds.includes(pupilId)).map((c) => c.id);
  }

  // ---- Tablets ------------------------------------------------------------

  isPupilPaired(pupilId) {
    return this.data.devices.some((d) => d.pupilId === pupilId);
  }

  // Creates a one-time code a pupil types into their tablet once.
  // Any older unused code for the same pupil is replaced.
  createPairingCode(pupilId) {
    if (!this.getPupil(pupilId)) throw new Error('Pupil not found');
    this.data.pairingCodes = this.data.pairingCodes.filter((c) => c.pupilId !== pupilId);
    let code;
    do code = newPairingCode();
    while (this.data.pairingCodes.some((c) => c.code === code));
    const entry = { code, pupilId, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
    this.data.pairingCodes.push(entry);
    this.save();
    return entry;
  }

  // Exchanges a pairing code for a long-lived device token.
  // Only a hash of the token is stored, so a leaked data file cannot be
  // used to impersonate tablets. Pairing a new tablet replaces the old one.
  redeemPairingCode(code) {
    const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const now = Date.now();
    this.data.pairingCodes = this.data.pairingCodes.filter((c) => c.expiresAt > now);
    const entry = this.data.pairingCodes.find((c) => c.code === normalised);
    if (!entry) return null;
    this.data.pairingCodes = this.data.pairingCodes.filter((c) => c !== entry);
    const token = crypto.randomBytes(32).toString('base64url');
    this.data.devices = this.data.devices.filter((d) => d.pupilId !== entry.pupilId);
    this.data.devices.push({ tokenHash: hashToken(token), pupilId: entry.pupilId, pairedAt: now });
    this.save();
    return { token, pupil: this.getPupil(entry.pupilId) };
  }

  pupilForDeviceToken(token) {
    if (!token) return null;
    const h = hashToken(token);
    const device = this.data.devices.find((d) => d.tokenHash === h);
    return device ? this.getPupil(device.pupilId) : null;
  }

  unpairPupil(pupilId) {
    this.data.devices = this.data.devices.filter((d) => d.pupilId !== pupilId);
    this.save();
  }
}
