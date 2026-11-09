#!/usr/bin/env node
import fs from 'node:fs';
import { Vault } from './vault.js';
import { protectRecords, assertClean } from './shield.js';
import { findPII } from './detectors.js';

const USAGE = `pii-shield — keep customer PII out of Claude while still analysing it

  pii-shield inspect <data.csv|.json> [--write-policy policy.json]
      Column names, fill counts and PII types found, plus a suggested policy.
      Prints no cell values, so it is safe to show Claude.

  pii-shield protect <data.csv|.json> --policy <policy.json> [--vault vault.enc] [--out safe.csv]
      Pseudonymize a file. The safe copy is what you share or upload; the
      encrypted vault (token -> real value) stays with you.

  pii-shield restore <file> --vault vault.enc [--out real.txt]
      Swap tokens in any text (e.g. Claude's answer) back to real values.
      With --out, writes the file and prints only a count.

  pii-shield ask <data.csv|.json> --policy <policy.json> "<question>" [--show-sent]
      Pseudonymize, ask Claude, print the answer with real values restored.

Key: PII_SHIELD_KEY, else ~/.pii-shield/key (auto-created). 'ask' also needs
Anthropic credentials.`;

const HEADER_RULES = [
  [/ssn|social.?sec|card.?(num|no)|^cc_|cvv|password|passport|license.?(num|no)|bank|routing|account.?num/i, 'drop'],
  [/e-?mail/i, 'tokenize:EMAIL'],
  [/phone|mobile|cell|tel\b|fax/i, 'tokenize:PHONE'],
  [/zip|postal/i, 'generalize:zip3'],
  [/dob|birth/i, 'generalize:year'],
  [/^age$|_age$/i, 'generalize:age_band'],
  [/address|street|addr/i, 'tokenize:ADDRESS'],
  [/^ip$|ip_?addr/i, 'tokenize:IP'],
  [/(^|_)(first|last|full|middle|customer|client|contact|shopper|lead)?_?name$|^name$/i, 'tokenize:NAME'],
  [/note|comment|message|body|description|transcript|text|remark/i, 'scan'],
];

export function inspect(records) {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const columns = cols.map((name) => {
    const vals = records.map((r) => r[name]).filter((v) => v != null && v !== '');
    const detected = {};
    let totalLen = 0;
    for (const v of vals) {
      totalLen += String(v).length;
      for (const h of findPII(String(v))) detected[h.type] = (detected[h.type] || 0) + 1;
    }
    const byHeader = HEADER_RULES.find(([re]) => re.test(name));
    let suggested = byHeader ? byHeader[1] : 'keep';
    if (suggested === 'keep' && Object.keys(detected).length) {
      const [top] = Object.entries(detected).sort((a, b) => b[1] - a[1]);
      const avg = vals.length ? totalLen / vals.length : 0;
      suggested = avg > 40 ? 'scan' : `tokenize:${top[0]}`;
    }
    return { name, filled: vals.length, piiFound: detected, suggested };
  });
  const policy = { default: 'drop', fields: Object.fromEntries(columns.map((c) => [c.name, c.suggested])) };
  return { rows: records.length, columns, policy };
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      opts[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { pos, opts };
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export function toCSV(records) {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...records.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function load(path) {
  const text = fs.readFileSync(path, 'utf8');
  return path.endsWith('.json') ? JSON.parse(text) : parseCSV(text);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  if (!cmd || opts.help) return console.log(USAGE);

  const vault = new Vault();
  const vaultPath = opts.vault || 'vault.enc';

  if (cmd === 'inspect') {
    const report = inspect(load(pos[0]));
    if (opts['write-policy']) fs.writeFileSync(opts['write-policy'], JSON.stringify(report.policy, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'protect') {
    const policy = JSON.parse(fs.readFileSync(opts.policy, 'utf8'));
    if (fs.existsSync(vaultPath)) vault.load(vaultPath);
    const { records, audit } = protectRecords(load(pos[0]), policy, vault);
    const out = pos[0].endsWith('.json') ? JSON.stringify(records, null, 2) + '\n' : toCSV(records);
    assertClean(out, vault);
    if (opts.out) fs.writeFileSync(opts.out, out);
    else process.stdout.write(out);
    vault.save(vaultPath);
    console.error(`pii-shield: ${JSON.stringify(audit)} — vault (${vault.size} tokens) saved to ${vaultPath}`);
  } else if (cmd === 'restore') {
    vault.load(vaultPath);
    const text = fs.readFileSync(pos[0] ?? 0, 'utf8');
    const restored = vault.restore(text);
    if (opts.out) {
      fs.writeFileSync(opts.out, restored);
      const n = [...text.matchAll(/\[[A-Z]+_[0-9a-f]{8}\]/g)].length;
      console.error(`pii-shield: restored ${n} tokens into ${opts.out}`);
    } else process.stdout.write(restored);
  } else if (cmd === 'ask') {
    const { analyze } = await import('./claude.js');
    const policy = JSON.parse(fs.readFileSync(opts.policy, 'utf8'));
    const res = await analyze({ records: load(pos[0]), policy, question: pos.slice(1).join(' '), vault });
    if (opts['show-sent']) console.error(`--- sent to Claude ---\n${res.sentText}\n----------------------`);
    console.error(`pii-shield: ${JSON.stringify(res.audit)}`);
    console.log(res.answer);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/pii-shield')) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
