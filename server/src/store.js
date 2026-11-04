// Persistent storage for the only thing that must survive a restart:
// the school's enrolled tablets (their number and a hash of their secret).
//
// Deliberately NOT stored: pupil names, lessons or what pupils are doing.
// Those live in memory only (see hub.js) and vanish when the lesson ends.
// This is "data minimisation" by design. Change it only after agreeing
// with the Data Protection Officer.
//
// Storage is a single JSON file, which is fine for a one-school prototype.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { tablets: [], setupCodes: [] };

// Codes avoid characters that are easy to confuse (0/O, 1/I/L).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000; // one day

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normaliseCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Tablet labels as written on the sticker: "7", "07", "A12", "T-3".
// Leading zeros are dropped from plain numbers so "07" and "7" are the same tablet.
export function normaliseTabletNumber(input) {
  let s = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) s = String(Number(s));
  return /^[A-Z0-9-]{1,8}$/.test(s) ? s : null;
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(EMPTY);
    if (filePath && fs.existsSync(filePath)) {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this.data = { tablets: loaded.tablets || [], setupCodes: loaded.setupCodes || [] };
    }
  }

  save() {
    if (!this.filePath) return; // in-memory mode (tests)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write to a temp file then rename, so a crash never leaves a half-written file.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ---- Setup codes ----------------------------------------------------------

  // A setup code can be used for many tablets during one day, so IT can set
  // up a whole trolley with one code.
  createSetupCode() {
    const now = Date.now();
    this.data.setupCodes = this.data.setupCodes.filter((c) => c.expiresAt > now);
    const entry = { code: randomCode(8), expiresAt: now + SETUP_CODE_TTL_MS };
    this.data.setupCodes.push(entry);
    this.save();
    return entry;
  }

  isValidSetupCode(code) {
    const c = normaliseCode(code);
    return this.data.setupCodes.some((s) => s.code === c && s.expiresAt > Date.now());
  }

  // ---- Tablets --------------------------------------------------------------

  listTablets() {
    return [...this.data.tablets].sort((a, b) =>
      a.number.localeCompare(b.number, undefined, { numeric: true }));
  }

  getTablet(id) {
    return this.data.tablets.find((t) => t.id === id) || null;
  }

  // Enrols a tablet. Re-using a number replaces the old tablet with that
  // number (e.g. after a factory reset). Returns the tablet's secret token,
  // which is shown to the tablet once; only its hash is kept.
  enrolTablet(setupCode, numberInput) {
    if (!this.isValidSetupCode(setupCode)) return { error: 'Setup code not recognised or expired' };
    const number = normaliseTabletNumber(numberInput);
    if (!number) return { error: 'Enter the number on the tablet sticker (letters, numbers or -)' };
    const replaced = this.data.tablets.find((t) => t.number === number) || null;
    this.data.tablets = this.data.tablets.filter((t) => t.number !== number);
    const token = crypto.randomBytes(32).toString('base64url');
    const tablet = { id: newId(), number, tokenHash: hashToken(token), enrolledAt: Date.now() };
    this.data.tablets.push(tablet);
    this.save();
    return { tablet, token, replaced };
  }

  tabletForToken(token) {
    if (!token) return null;
    const h = hashToken(token);
    return this.data.tablets.find((t) => t.tokenHash === h) || null;
  }

  removeTablet(id) {
    this.data.tablets = this.data.tablets.filter((t) => t.id !== id);
    this.save();
  }
}
