import { findPII } from './detectors.js';
import { TOKEN_RE } from './vault.js';

export class PIILeakError extends Error {
  constructor(findings) {
    // Report types and counts only — never the values themselves.
    const summary = Object.entries(findings).map(([t, n]) => `${t}×${n}`).join(', ');
    super(`Blocked: outgoing payload still contains PII (${summary}). Nothing was sent.`);
    this.name = 'PIILeakError';
    this.findings = findings;
  }
}

const GENERALIZERS = {
  // 90210 -> 902xx : keeps regional analysis, drops the exact neighbourhood.
  zip3: (v) => {
    const m = String(v).match(/\d{5}/);
    return m ? `${m[0].slice(0, 3)}xx` : null;
  },
  year: (v) => {
    const m = String(v).match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : null;
  },
  month: (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
  },
  age_band: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n >= 80) return '80+';
    const lo = Math.floor(n / 10) * 10;
    return `${lo}-${lo + 9}`;
  },
  // City-level only, e.g. "123 Main St, Torrance, CA 90501" -> "Torrance, CA"
  city_state: (v) => {
    const m = [...String(v).matchAll(/([A-Za-z][A-Za-z .'-]*?),\s*([A-Z]{2})\b/g)].pop();
    return m ? `${m[1].trim()}, ${m[2]}` : null;
  },
};

function newAudit() {
  return { records: 0, tokenized: {}, generalized: 0, dropped: 0, redacted: 0 };
}

function bump(audit, type, n = 1) {
  audit.tokenized[type] = (audit.tokenized[type] || 0) + n;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pseudonymize free text: known customer names first (so "Jane" in a note is
 * caught even without an honorific), then pattern detectors.
 */
export function scanText(text, vault, audit = newAudit(), names = []) {
  if (text == null) return text;
  let out = String(text);

  // Longest names first so "Jane Smith" wins over "Jane".
  for (const { value, token } of [...names].sort((a, b) => b.value.length - a.value.length)) {
    const re = new RegExp(`\\b${escapeRe(value)}\\b`, 'gi');
    out = out.replace(re, () => {
      bump(audit, 'NAME');
      return token;
    });
  }

  const hits = findPII(out).filter((h) => !insideToken(out, h.start));
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const token = vault.tokenize(h.type, h.value, h.normalize ? h.normalize(h.value) : h.value);
    out = out.slice(0, h.start) + token + out.slice(h.end);
    bump(audit, h.type);
  }
  return out;
}

function insideToken(text, idx) {
  for (const m of text.matchAll(TOKEN_RE)) {
    if (idx >= m.index && idx < m.index + m[0].length) return true;
  }
  return false;
}

function parseRule(rule) {
  const [action, arg] = String(rule).split(':');
  return { action, arg };
}

/**
 * Apply a field policy to an array of flat records.
 *
 * Policy rules per field:
 *   keep              pass through (non-identifying: model, price, dates…)
 *   tokenize:TYPE     replace with a stable pseudonym, e.g. tokenize:EMAIL
 *   generalize:KIND   zip3 | year | month | age_band | city_state
 *   scan              free text — detect and tokenize PII inside it
 *   redact            replace with [REDACTED] (presence kept, value gone)
 *   drop              remove the field entirely
 * `default` applies to any field the policy does not list ("scan" unless set;
 * use "drop" for a strict allow-list).
 */
export function protectRecords(records, policy, vault) {
  const fields = policy.fields || {};
  const fallback = policy.default || 'scan';
  const audit = newAudit();

  // Pass 1: every name in a tokenized name column, so free text anywhere in
  // the dataset that mentions that customer gets the same token.
  const globalNames = [];
  const seen = new Set();
  const nameFields = Object.entries(fields)
    .filter(([, r]) => parseRule(r).action === 'tokenize' && parseRule(r).arg === 'NAME')
    .map(([f]) => f);
  for (const rec of records) {
    for (const f of nameFields) {
      const v = rec[f];
      if (!v || seen.has(String(v).toLowerCase())) continue;
      seen.add(String(v).toLowerCase());
      globalNames.push({ value: String(v).trim(), token: vault.tokenize('NAME', String(v).trim(), String(v).trim().toLowerCase()) });
    }
  }

  const out = records.map((rec) => {
    audit.records++;
    // Within a record, first/last name parts alone also map to that customer.
    const localNames = [...globalNames];
    for (const f of nameFields) {
      if (!rec[f]) continue;
      const full = String(rec[f]).trim();
      const token = vault.tokenize('NAME', full, full.toLowerCase());
      for (const part of full.split(/\s+/)) if (part.length >= 3) localNames.push({ value: part, token });
    }

    const safe = {};
    for (const [key, value] of Object.entries(rec)) {
      const { action, arg } = parseRule(fields[key] ?? fallback);
      if (value == null || value === '') {
        if (action !== 'drop') safe[key] = value;
        continue;
      }
      switch (action) {
        case 'keep':
          safe[key] = value;
          break;
        case 'tokenize': {
          const type = (arg || 'ID').toUpperCase();
          const det = findPII(String(value))[0];
          const norm = det && det.type === type && det.normalize ? det.normalize(String(value)) : String(value).trim().toLowerCase();
          safe[key] = vault.tokenize(type, String(value).trim(), norm);
          bump(audit, type);
          break;
        }
        case 'generalize': {
          const fn = GENERALIZERS[arg];
          if (!fn) throw new Error(`Unknown generalizer "${arg}" on field "${key}"`);
          safe[key] = fn(value);
          audit.generalized++;
          break;
        }
        case 'scan':
          safe[key] = typeof value === 'string' ? scanText(value, vault, audit, localNames) : value;
          break;
        case 'redact':
          safe[key] = '[REDACTED]';
          audit.redacted++;
          break;
        case 'drop':
          audit.dropped++;
          break;
        default:
          throw new Error(`Unknown policy action "${action}" on field "${key}"`);
      }
    }
    return safe;
  });

  return { records: out, audit };
}

/**
 * Last line of defence, run on the exact string about to be sent. Fails
 * closed: if any detector fires, or any original value the vault knows about
 * appears verbatim, it throws and nothing goes out.
 */
export function assertClean(payload, vault) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const findings = {};
  for (const h of findPII(text)) {
    if (insideToken(text, h.start)) continue;
    findings[h.type] = (findings[h.type] || 0) + 1;
  }
  if (vault) {
    const lower = text.toLowerCase();
    for (const [token, original] of vault.map) {
      const v = String(original).toLowerCase();
      if (v.length >= 4 && lower.includes(v)) {
        const type = token.slice(1, token.indexOf('_'));
        findings[type] = (findings[type] || 0) + 1;
      }
    }
  }
  if (Object.keys(findings).length) throw new PIILeakError(findings);
  return text;
}
