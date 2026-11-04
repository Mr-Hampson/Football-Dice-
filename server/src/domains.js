// Helpers for the "allowed sites" list.
//
// We work with domains (e.g. "bbc.co.uk"), not full web addresses. That is all
// the teacher needs to judge "on task", and it means far less personal data.
// The Android app uses the same matching rule (see Classifier.kt) - keep the
// two in step if you change it.

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Accepts things a teacher might type ("https://www.bbc.co.uk/bitesize",
// "BBC.co.uk", "classroom.google.com") and returns a bare domain, or null.
export function normaliseDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/)[0]; // path, query, fragment
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^www\./, '');
  return DOMAIN_RE.test(s) ? s : null;
}

export function normaliseDomainList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const d = normaliseDomain(item);
    if (d && !out.includes(d)) out.push(d);
  }
  return out.slice(0, 100);
}

// "www.bbc.co.uk" matches allowed "bbc.co.uk"; "notbbc.co.uk" does not.
export function domainMatches(host, allowed) {
  const h = normaliseDomain(host);
  if (!h) return null;
  return allowed.find((a) => h === a || h.endsWith(`.${a}`)) || null;
}

// Android package names, e.g. "com.amazon.kindle". Used for allowed apps.
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function normalisePackageList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const p = typeof item === 'string' ? item.trim() : '';
    if (PACKAGE_RE.test(p) && p.length <= 200 && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 50);
}

// Only allow ordinary web links to be sent to pupils.
export function normaliseLink(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!normaliseDomain(url.hostname)) return null;
  return url.toString();
}
