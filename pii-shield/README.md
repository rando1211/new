# pii-shield

Middleware that sits between customer data and Claude. Real names, emails,
phones, addresses and card numbers are swapped for **stable pseudonyms**
before anything is sent. Claude analyzes the pseudonymized data, and the
answer is swapped back to real values on your side.

```
 your data ──► protect ──► [NAME_e5cea039] … ──► Claude ──► "[NAME_e5cea039] has 2 open interests"
  (real)       (policy +                                            │
                leak guard)          vault (token → real, stays local, encrypted)
                                                                    ▼
                                                   restore ──► "Jane Smith has 2 open interests"
```

## Why analysis still works

Tokens are a keyed HMAC of the normalized value, so:

- `Jane.Smith@gmail.com` and `jane.smith@gmail.com` get the same token, and so
  do `(310) 555-0142`, `310.555.0142` and `+13105550142`. Claude can still
  count unique shoppers, dedupe, join tables and follow one customer across
  rows and batches.
- Columns that don't identify anyone (model, rooftop, price, timestamps) pass
  through unchanged.
- Quasi-identifiers are coarsened rather than deleted: ZIP `90501` → `905xx`,
  a date of birth → its year, an age → a 10-year band.
- Free-text fields (notes, transcripts) are scanned. Known customer names, plus
  emails, phones, card numbers (Luhn-checked), SSNs, street addresses, IPs and
  "Mr./Mrs./Dr. Name" are tokenized in place.

Without the key, a token can't be reversed or brute-forced (for example by
hashing every phone number in an area code).

## Protections

1. **Field policy:** each column is set to `keep`, `tokenize:TYPE`,
   `generalize:KIND`, `scan`, `redact` or `drop`. Set `"default": "drop"` so a
   new column can't leak by accident.
2. **Leak guard (`assertClean`):** checks the exact request text right
   before sending. If any detector matches, or any real value the vault knows
   about appears verbatim, the request is blocked and nothing is sent. The
   error lists types and counts only, never the values.
3. **Encrypted vault:** the token → value map exists only in memory, or is
   saved to disk with AES-256-GCM under `PII_SHIELD_KEY`.
4. **Audit:** each run reports counts per category (records, tokenized by
   type, generalized, dropped). These are safe to log.

## Usage

```bash
export PII_SHIELD_KEY=$(openssl rand -hex 32)   # store it in your secrets manager
```

Create a safe copy of a file to upload anywhere, including claude.ai:

```bash
node src/cli.js protect examples/interests.csv --policy examples/policy.interests.json --out safe.csv
```

Turn a pasted Claude answer back into real names:

```bash
node src/cli.js restore answer.txt --vault vault.enc
```

Ask Claude in one step (needs `ANTHROPIC_API_KEY`):

```bash
node src/cli.js ask examples/interests.csv --policy examples/policy.interests.json "Which shoppers have more than one open interest, and which models?" --show-sent
```

From code:

```js
import { Vault } from './src/vault.js';
import { analyze } from './src/claude.js';

const vault = new Vault();                       // reads PII_SHIELD_KEY
const { answer, audit } = await analyze({ records, policy, question, vault });
```

`analyze` uses `claude-opus-5-5` (override with `PII_SHIELD_MODEL`) and turns
on server-side refusal fallbacks. The question is scrubbed too, so asking
"what did Jane Smith look at?" sends Jane's token, not her name.

## Limits

- Name detection in free text covers names from the dataset's name columns
  and names after an honorific. An unknown name with no honorific in a note
  ("my brother Mike called") is not caught. For high-risk free text, add an
  NER pass (e.g. Microsoft Presidio) in `scanText`, or `redact` the column.
- Pseudonymized data is still personal data under GDPR and CCPA. Combined
  with the key, it can be re-identified. This lowers what Claude sees; it does
  not replace your data-processing agreements.
- Claude can't reason about the hidden values themselves (for example, which
  email domain is most common). To allow that, add a derived `keep` column such
  as `email_domain` before protecting.

## Tests

```bash
npm test
```
