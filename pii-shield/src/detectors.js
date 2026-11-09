// Pattern detectors for PII that shows up in free text (notes, transcripts,
// email bodies). Structured columns are handled by the field policy instead;
// these are the safety net for everything else.

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Order matters: more specific patterns run first so a card number is not
// half-eaten by the phone pattern.
export const DETECTORS = [
  {
    type: 'EMAIL',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    normalize: (s) => s.toLowerCase(),
  },
  {
    type: 'CARD',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (s) => luhnValid(s.replace(/\D/g, '')),
    normalize: (s) => s.replace(/\D/g, ''),
  },
  {
    type: 'SSN',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    normalize: (s) => s.replace(/\D/g, ''),
  },
  {
    type: 'PHONE',
    pattern: /(?:\+1[ .-]?)?\(?\b[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}\b|\+[1-9]\d{9,14}\b/g,
    normalize: (s) => {
      const d = s.replace(/\D/g, '');
      return d.length === 10 ? `1${d}` : d;
    },
  },
  {
    type: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    type: 'ADDRESS',
    pattern:
      /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Ter|Terrace)\b\.?(?:,?\s+(?:Apt|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g,
    normalize: (s) => s.toLowerCase().replace(/\s+/g, ' '),
  },
  {
    // Honorific + capitalised name: "Mr. Garcia", "Dr. Jane Smith".
    type: 'NAME',
    pattern: /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?/g,
    normalize: (s) => s.toLowerCase(),
  },
];

/** Every PII match in `text`, non-overlapping, in order. */
export function findPII(text) {
  const hits = [];
  const taken = [];
  for (const det of DETECTORS) {
    for (const m of text.matchAll(det.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (det.accept && !det.accept(m[0])) continue;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      hits.push({ type: det.type, value: m[0], start, end, normalize: det.normalize });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
