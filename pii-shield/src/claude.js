import Anthropic from '@anthropic-ai/sdk';
import { protectRecords, scanText, assertClean } from './shield.js';

const SYSTEM = `You are a data analyst working on a pseudonymized customer dataset.

Values written like [NAME_3f9a1c2b], [EMAIL_…], [PHONE_…], [ADDRESS_…] are stable
pseudonyms: the same token always means the same real person or value, so you can
count, group, join and deduplicate on them exactly as you would on the originals.

Rules:
- Refer to people and contact details only by their tokens, copied exactly,
  brackets included. They are swapped back to real values after you answer.
- Never guess, reconstruct or ask for the real values behind a token.
- Fields like "902xx" (ZIP prefix), a bare year, or an age band are deliberately
  coarsened; analyse at that level.`;

/**
 * Pseudonymize `records`, ask Claude `question` about them, and return the
 * answer with real customer values restored locally.
 *
 * Nothing leaves the process until assertClean() has passed on the exact
 * request text.
 */
export async function analyze({
  records,
  policy,
  question,
  vault,
  client = new Anthropic(),
  model = process.env.PII_SHIELD_MODEL || 'claude-opus-5-5',
  effort = 'high',
  restore = true,
}) {
  const { records: safeRecords, audit } = protectRecords(records, policy, vault);
  // Names typed into the question ("how many bikes did Jane Smith look at?")
  // map to the same token as in the data.
  const knownNames = [...vault.map]
    .filter(([tok]) => tok.startsWith('[NAME_'))
    .map(([token, value]) => ({ token, value: String(value) }));
  const safeQuestion = scanText(question, vault, audit, knownNames);

  const userText =
    `<dataset rows="${safeRecords.length}">\n` +
    safeRecords.map((r) => JSON.stringify(r)).join('\n') +
    `\n</dataset>\n\n${safeQuestion}`;

  assertClean(SYSTEM + userText, vault);

  const message = await client.beta.messages
    .stream({
      model,
      max_tokens: 64000,
      output_config: { effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    })
    .finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${message.stop_details?.category ?? 'no category'}).`);
  }

  const raw = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    answer: restore ? vault.restore(raw) : raw,
    pseudonymizedAnswer: raw,
    sentText: userText, // exactly what Claude saw — useful for audits
    audit,
    usage: message.usage,
  };
}
