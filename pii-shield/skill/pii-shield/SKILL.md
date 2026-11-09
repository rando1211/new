---
name: pii-shield
description: Analyze customer data (leads, CRM exports, orders, contact lists, call notes, form fills) without ever seeing customers' real names, emails, phones, addresses or card numbers. Swaps them for stable pseudonyms, runs the analysis on the safe copy, and returns results with real values restored in a file. Use this whenever the user shares or points to a CSV/JSON/Excel file containing customer or personal information and wants it analyzed, summarized, deduped, segmented or reported on, or says things like "protect customer info", "don't expose PII", "anonymize/mask/redact this before you look at it", "keep this data private", or "HIPAA/GDPR/CCPA-safe analysis", even if they don't name this skill.
---

# PII Shield

Lets you analyze customer data while real customer details stay out of the
conversation. Every name, email, phone, address and card number becomes a token
like `[NAME_e5cea039]`. The same person always gets the same token, so counts,
joins, dedupes and per-customer rollups still work. Real values come back only
in a file the user opens. They never go into your context or the chat.

## The one rule that matters

**Don't read the raw file.** That means no `cat`, `head`, pandas `print`, or
preview, and no "let me take a quick look at the first rows." The protection
only works if real values never enter your context. Run the scripts on the raw
file and read only what they print, plus the protected copy. If you need to
know what's in a column, use `inspect`: it reports column names, fill counts
and PII types found, never values.

If the user pastes customer details straight into the chat, they are already
in context. Do the analysis, and point out that uploading the file and using
this workflow would have kept those details out.

## Setup

The scripts are plain Node.js (18+) with no dependencies:

```bash
SHIELD="node <this-skill-dir>/scripts/cli.js"
```

The secret key is created automatically at `~/.pii-shield/key` on first use, or
read from `PII_SHIELD_KEY`. Never print the key or show it to the user.

If the input is Excel, convert it to CSV without printing it:

```bash
python3 -c "import pandas as pd; pd.read_excel('IN.xlsx').to_csv('raw.csv', index=False)"
```

Keep working files (`raw.csv`, `policy.json`, `vault.enc`, `safe.csv`) together
in a working folder, not in the outputs folder. The vault holds the real values
(encrypted) and stays with the user.

## Workflow

### 1. Inspect

```bash
$SHIELD inspect raw.csv --write-policy policy.json
```

This prints each column's name, how many rows have a value, which PII types the
detectors found, and a suggested rule. It also writes the suggested policy.

### 2. Review the policy

Open `policy.json` and adjust it from the column names and the user's question.
These are the rules:

| Rule | Use for | Effect |
|---|---|---|
| `keep` | products, prices, dates, statuses, store names | unchanged |
| `tokenize:NAME` / `EMAIL` / `PHONE` / `ADDRESS` / `ID` | anything that identifies a person | stable pseudonym |
| `generalize:zip3` / `year` / `month` / `age_band` / `city_state` | location, birth date, age | coarsened (90501 → 905xx) |
| `scan` | free text: notes, comments, transcripts | PII inside the text is tokenized |
| `redact` | sensitive field where only "has a value" matters | `[REDACTED]` |
| `drop` | SSNs, card numbers, passwords, anything not needed | removed |

Keep `"default": "drop"`, so any column the policy doesn't list is left out.
Lean toward keeping what the analysis needs. If the user wants "leads by city",
use `generalize:city_state` on the address, not `drop`. If they need something
derived from a hidden value, such as email domain, ask before adding a
`keep` column for it.

Tell the user in one or two lines what will be tokenized, coarsened and
dropped. They know their data better than the detectors do.

### 3. Protect

```bash
$SHIELD protect raw.csv --policy policy.json --vault vault.enc --out safe.csv
```

Before writing, this runs a leak guard. If any PII pattern or known real value
survives, it fails and writes nothing. If it fails, the error names the PII
type: find the column (rerun `inspect`), tighten its rule, and try again. Don't
work around the guard.

### 4. Analyze `safe.csv`

From here on it's ordinary analysis. Read `safe.csv`, use pandas, build charts,
whatever the question needs. Treat tokens as opaque IDs and group, count and
join on them. Don't try to guess who a token is.

### 5. Write results and restore

Write the answer or report (markdown, CSV, etc.) using the tokens, then make
the real-value copy for the user:

```bash
$SHIELD restore report.md --vault vault.enc --out report_with_names.md
```

`restore --out` prints only a count. Give the user the restored file and don't
open it yourself. In chat, describe findings with tokens or in aggregate (for
example, "3 shoppers had 2+ open interests; names are in the file").

## Repeat runs and teams

- Using the same key and vault across files gives the same customer the same
  token, so separate exports can be joined. Pass `--vault` to an existing
  vault and it grows.
- Each person who uses the skill gets their own key automatically. Teammates
  who need to restore each other's results must share one key through a
  password manager or a `PII_SHIELD_KEY` secret, never through chat or email.

## What it does and doesn't catch

Caught: names from name columns (also when they appear in notes), emails, US
and international phones, card numbers (checksum-verified), SSNs, US street
addresses, IPs, and "Mr./Mrs./Dr. Name".

Not caught: an unfamiliar name with no honorific in free text ("my brother
Mike called"). If notes are sensitive and the analysis doesn't need them,
`drop` or `redact` that column, and mention this to the user.

On claude.ai, the uploaded file itself still sits in the session's sandbox.
This skill keeps the values out of the conversation and out of anything you
write. If the user needs the raw file never to leave their machine, have them
run steps 1–3 locally and upload only `safe.csv`. The same scripts work on any
computer with Node.js.
