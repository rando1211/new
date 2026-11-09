import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { protectRecords, scanText, assertClean, PIILeakError } from '../src/shield.js';
import { analyze } from '../src/claude.js';
import { parseCSV } from '../src/cli.js';

const KEY = 'k'.repeat(64);
const here = path.dirname(new URL(import.meta.url).pathname);
const rows = parseCSV(fs.readFileSync(path.join(here, '../examples/interests.csv'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(here, '../examples/policy.interests.json'), 'utf8'));

test('no raw PII survives protection', () => {
  const vault = new Vault(KEY);
  const { records } = protectRecords(rows, policy, vault);
  const out = JSON.stringify(records);
  for (const raw of ['Jane', 'Smith', 'Carlos', 'gmail.com', '555-0142', '5550199', '412 Pacific', '4111', 'Lee', '90501']) {
    assert.ok(!out.includes(raw), `leaked ${raw}`);
  }
  assert.doesNotThrow(() => assertClean(out, vault));
});

test('same customer gets the same token across rows and formats', () => {
  const vault = new Vault(KEY);
  const { records } = protectRecords(rows, policy, vault);
  const [jane1, , jane2] = records;
  assert.equal(jane1.name, jane2.name);
  assert.equal(jane1.email, jane2.email, 'email is case-insensitive');
  assert.equal(jane1.phone, jane2.phone, 'phone ignores formatting');
  assert.ok(jane1.notes.includes(jane1.name), 'name inside notes maps to same token');
  assert.ok(jane1.notes.includes(jane1.phone), 'phone inside notes maps to same token');
});

test('tokens are stable under one key and differ under another', () => {
  const a = new Vault(KEY).tokenize('EMAIL', 'x@y.com');
  const b = new Vault(KEY).tokenize('EMAIL', 'x@y.com');
  const c = new Vault('z'.repeat(64)).tokenize('EMAIL', 'x@y.com');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('analytic fields are kept or coarsened, not destroyed', () => {
  const vault = new Vault(KEY);
  const { records } = protectRecords(rows, policy, vault);
  assert.equal(records[0].model_key, 'honda-grom');
  assert.equal(records[0].postal_code, '905xx');
  assert.equal(records[0].created_at, '2026-10-02T14:11:00Z');
});

test('default "drop" removes unlisted columns', () => {
  const vault = new Vault(KEY);
  const { records, audit } = protectRecords([{ id: 1, ssn: '123-45-6789' }], { default: 'drop', fields: { id: 'keep' } }, vault);
  assert.deepEqual(records[0], { id: 1 });
  assert.equal(audit.dropped, 1);
});

test('restore swaps tokens back and leaves unknown tokens alone', () => {
  const vault = new Vault(KEY);
  const t = scanText('email jane@x.com or call 310-555-0142', vault);
  assert.equal(vault.restore(t), 'email jane@x.com or call 310-555-0142');
  assert.equal(vault.restore('[EMAIL_00000000]'), '[EMAIL_00000000]');
});

test('assertClean fails closed and does not echo the value', () => {
  const vault = new Vault(KEY);
  vault.tokenize('NAME', 'Jane Smith');
  assert.throws(() => assertClean('call 310-555-0142', vault), PIILeakError);
  try {
    assertClean('note about jane smith', vault);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof PIILeakError);
    assert.ok(!e.message.toLowerCase().includes('jane'));
  }
});

test('card numbers need a valid Luhn checksum', () => {
  const vault = new Vault(KEY);
  assert.match(scanText('card 4111 1111 1111 1111', vault), /\[CARD_/);
  assert.doesNotMatch(scanText('order 1234 5678 9012 3456', vault), /\[CARD_/);
});

test('vault round-trips through encrypted file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pii-')), 'v.enc');
  const v1 = new Vault(KEY);
  const tok = v1.tokenize('EMAIL', 'a@b.com');
  v1.save(file);
  assert.ok(!fs.readFileSync(file).toString('latin1').includes('a@b.com'));
  assert.equal(new Vault(KEY).load(file).restore(tok), 'a@b.com');
  assert.throws(() => new Vault('w'.repeat(64)).load(file));
});

test('analyze sends only pseudonymized text and restores the answer', async () => {
  const vault = new Vault(KEY);
  let sent;
  const fakeClient = {
    beta: {
      messages: {
        stream(req) {
          sent = req;
          const tok = req.messages[0].content.match(/\[NAME_[0-9a-f]{8}\]/)[0];
          return {
            finalMessage: async () => ({
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: `${tok} has 2 open interests.` }],
              usage: {},
            }),
          };
        },
      },
    },
  };
  const res = await analyze({
    records: rows,
    policy,
    question: 'Which shopper has the most interests? Is it Jane Smith?',
    vault,
    client: fakeClient,
  });
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes('Jane'), 'question was scrubbed too');
  assert.ok(!wire.includes('gmail'));
  assert.equal(res.answer, 'Jane Smith has 2 open interests.');
});
