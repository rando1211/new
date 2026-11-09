#!/usr/bin/env node
import fs from 'node:fs';
import { Vault } from './vault.js';
import { protectRecords, assertClean } from './shield.js';

const USAGE = `pii-shield — keep customer PII out of Claude while still analysing it

  pii-shield protect <data.csv|.json> --policy <policy.json> [--vault vault.enc] [--out safe.csv]
      Pseudonymize a file. The safe copy is what you share or upload; the
      encrypted vault (token -> real value) stays with you.

  pii-shield restore <file> --vault vault.enc
      Swap tokens in any text (e.g. Claude's answer) back to real values.

  pii-shield ask <data.csv|.json> --policy <policy.json> "<question>" [--show-sent]
      Pseudonymize, ask Claude, print the answer with real values restored.

Needs PII_SHIELD_KEY (32+ chars). 'ask' also needs Anthropic credentials.`;

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
    process.stdout.write(vault.restore(fs.readFileSync(pos[0] ?? 0, 'utf8')));
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
