// Pupils type their own name when joining a lesson: first name + the first
// letter of their surname, e.g. "Amy K". This keeps names short and avoids
// collecting full names. The Android app shows the same rule as a hint.

const NAME_RE = /^[\p{L}'’-]+(?: [\p{L}'’-]+)* \p{L}$/u;

// Returns a tidy name ("amy  k." -> "Amy K") or null if it doesn't fit.
export function normalisePupilName(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  if (s.length < 3 || s.length > 30 || !NAME_RE.test(s)) return null;
  s = s
    .split(' ')
    .map((w) => w.charAt(0).toLocaleUpperCase('en-GB') + w.slice(1))
    .join(' ');
  return s;
}

export const NAME_RULE = 'Type your first name and the first letter of your surname, e.g. Amy K';
