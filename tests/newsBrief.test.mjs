/**
 * The AI brief's prompt and parser.
 *
 * These are the two halves of the feature that can be checked without spending
 * a key, and they are also where it is most likely to break: the prompt is what
 * stops the model inventing prices, and the parser has to survive whatever
 * shape a model chooses to answer in on the day. Both are pure functions, so
 * the network is not involved here at all.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIEF_SECTIONS,
  buildBriefPrompt,
  parseBrief,
  tidySource,
  dedupeSources,
} from '../app/lib/newsBrief.js';

const ids = (reply) => parseBrief(reply).sections.map((s) => s.id);
const section = (reply, id) => parseBrief(reply).sections.find((s) => s.id === id);

test('reads the format the prompt asks for', () => {
  const reply = [
    '[NIFTY]',
    '- Closed at 25,010, up 0.4%, led by financials.',
    '- Breadth positive: 32 of 50 advanced.',
    '[INDIA]',
    '- FIIs net buyers of Rs 1,240 cr.',
    '[GOLD]',
    '- Domestic gold firm on a softer dollar.',
    '[SILVER]',
    '- Silver outpaced gold, up 1.2%.',
    '[WATCH]',
    '- US CPI print tonight.',
  ].join('\n');

  assert.deepEqual(ids(reply), ['nifty', 'india', 'gold', 'silver', 'watch']);
  assert.deepEqual(section(reply, 'nifty').points, [
    'Closed at 25,010, up 0.4%, led by financials.',
    'Breadth positive: 32 of 50 advanced.',
  ]);
  assert.equal(section(reply, 'india').label, 'India market');
});

test('reads the markdown a model sends instead', () => {
  // Every one of these is a real shape a model returns when asked for `[NIFTY]`.
  // Insisting on the bracket spelling would throw away a good answer.
  const reply = [
    '## NIFTY',
    '* **Closed at 25,010**, up 0.4%',
    '## INDIA',
    '1. FIIs net buyers',
    '**GOLD**',
    '- Firm',
    'SILVER:',
    '- Up 1.2%',
    '### WATCH',
    '- CPI tonight',
  ].join('\n');

  assert.deepEqual(ids(reply), ['nifty', 'india', 'gold', 'silver', 'watch']);
  assert.deepEqual(section(reply, 'nifty').points, ['Closed at 25,010, up 0.4%']);
  assert.deepEqual(section(reply, 'india').points, ['FIIs net buyers']);
});

test('strips the citation markers a grounded reply carries', () => {
  const reply = '[NIFTY]\n- NIFTY closed at 25,010 [1][2]\n- Financials led [3]';
  assert.deepEqual(section(reply, 'nifty').points, [
    'NIFTY closed at 25,010',
    'Financials led',
  ]);
});

test('marks a section the model had nothing for, without dropping it', () => {
  const reply = [
    '[NIFTY]', '- Up 0.4%',
    '[INDIA]', 'No notable news.',
    '[GOLD]',
    '[SILVER]', '- Flat',
    '[WATCH]', '- CPI',
  ].join('\n');

  assert.equal(section(reply, 'india').empty, true, '"No notable news." is empty');
  assert.equal(section(reply, 'gold').empty, true, 'a bare header is empty');
  assert.equal(section(reply, 'nifty').empty, false);
  // Kept in the list: a section that was asked and came back blank is a fact
  // about the day, and hiding it looks like the request half-failed.
  assert.ok(ids(reply).includes('gold'));
});

test('returns sections in registry order, not reply order', () => {
  assert.deepEqual(ids('[WATCH]\n- x\n[NIFTY]\n- y'), ['nifty', 'watch']);
});

test('keeps a reply that has no headers at all', () => {
  const reply = 'The Indian market closed higher today.\n\nGold was firm and silver outperformed.';
  const out = parseBrief(reply);
  assert.equal(out.sections.length, 0);
  assert.deepEqual(out.unstructured, [
    'The Indian market closed higher today.',
    'Gold was firm and silver outperformed.',
  ]);
});

test('does not attribute preamble to the first section', () => {
  const reply = 'Here is your brief for today.\n[NIFTY]\n- Up 0.4%';
  assert.deepEqual(section(reply, 'nifty').points, ['Up 0.4%']);
});

test('survives degenerate input', () => {
  for (const bad of ['', null, undefined, '   \n \n', 0]) {
    assert.deepEqual(parseBrief(bad), { sections: [], unstructured: null });
  }
  assert.ok(parseBrief('[NIFTY]\n[GOLD]').sections.every((s) => s.empty));
});

test('hands the model live numbers as facts it may not alter', () => {
  const prompt = buildBriefPrompt({
    prices: {
      NIFTY: { cur: 25010.5, prev: 24910.2 },
      GOLD: { cur: 124.5, prev: 124.0 },
      SILVER: null,
    },
    headlines: [{ headline: 'Sensex rallies', time: '2h ago', source: 'Reuters' }],
    marketStatus: 'Market Open — closes in 30m',
  });

  assert.match(prompt, /NIFTY 50: 25010\.50 \(\+100\.30, \+0\.40% vs previous close 24910\.20\)/);
  assert.match(prompt, /Use them exactly as given/);
  // A missing feed is admitted rather than defaulted to zero, which would be a
  // fabricated price the model would then explain.
  assert.match(prompt, /Silver \(SILVERBEES ETF proxy\): no live price/);
  assert.match(prompt, /- Sensex rallies \[2h ago\] — Reuters/);
  assert.match(prompt, /Market Open — closes in 30m/);
  for (const s of BRIEF_SECTIONS) {
    assert.ok(prompt.includes(`[${s.id.toUpperCase()}]`), `asks for ${s.id}`);
  }
});

test('states an empty headline feed rather than leaving a blank', () => {
  assert.match(buildBriefPrompt({ prices: {} }), /HEADLINES: none available/);
});

test('names sources readably', () => {
  assert.deepEqual(
    tidySource({ title: 'Economic Times', url: 'https://x.com/a' }),
    { title: 'Economic Times', url: 'https://x.com/a' }
  );
  // Grounded replies cite opaque redirect URLs, so the host is the fallback.
  assert.deepEqual(
    tidySource({ url: 'https://www.reuters.com/markets/x' }),
    { title: 'reuters.com', url: 'https://www.reuters.com/markets/x' }
  );
  assert.equal(tidySource({ url: 'not a url' }).title, 'not a url');
  assert.equal(tidySource({}), null);
});

test('collapses duplicate sources and drops empty ones', () => {
  const out = dedupeSources([
    { title: 'A', url: 'https://a.com/1' },
    { title: 'A again', url: 'https://a.com/1' },
    { title: 'B', url: 'https://b.com/2' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(dedupeSources([{}, { url: '' }, { title: 'Live Mint' }]).length, 1);
});
