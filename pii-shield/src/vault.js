import crypto from 'node:crypto';
import fs from 'node:fs';

// Matches every token the vault can mint, e.g. [EMAIL_3f9a1c2b].
export const TOKEN_RE = /\[([A-Z]+)_([0-9a-f]{8})\]/g;

/**
 * Deterministic, keyed pseudonyms. The same customer value always maps to the
 * same token under the same key, so Claude can still count, join, dedupe and
 * follow one customer across rows and batches — but the token is an HMAC, so
 * nobody without the key can reverse or brute-force it from outside.
 *
 * The token -> real value map never leaves this process unless you call
 * save(), which writes it AES-256-GCM encrypted.
 */
export class Vault {
  constructor(key = process.env.PII_SHIELD_KEY) {
    if (!key || key.length < 32) {
      throw new Error('PII_SHIELD_KEY must be set to at least 32 characters (e.g. `openssl rand -hex 32`).');
    }
    this.hmacKey = crypto.createHash('sha256').update(`hmac:${key}`).digest();
    this.encKey = crypto.createHash('sha256').update(`enc:${key}`).digest();
    this.map = new Map(); // token -> original (first-seen display form)
  }

  tokenize(type, value, normalized = value) {
    const digest = crypto
      .createHmac('sha256', this.hmacKey)
      .update(`${type}:${String(normalized).trim()}`)
      .digest('hex')
      .slice(0, 8);
    const token = `[${type}_${digest}]`;
    if (!this.map.has(token)) this.map.set(token, value);
    return token;
  }

  /** Replace every known token in `text` with its real value. Unknown tokens are left as-is. */
  restore(text) {
    return String(text).replace(TOKEN_RE, (tok) => (this.map.has(tok) ? this.map.get(tok) : tok));
  }

  get size() {
    return this.map.size;
  }

  save(path) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify([...this.map])), cipher.final()]);
    const out = Buffer.concat([iv, cipher.getAuthTag(), body]);
    fs.writeFileSync(path, out, { mode: 0o600 });
  }

  load(path) {
    const buf = fs.readFileSync(path);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    for (const [k, v] of JSON.parse(json)) this.map.set(k, v);
    return this;
  }
}
