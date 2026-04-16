import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash, setPhase, updateBash } from '../scripts/lib/bashjson.mjs';
import { regenerateIndex } from '../scripts/lib/indexmd.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-idx-')); }

test('index: empty root creates empty INDEX.md', () => {
  const root = mkroot();
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /# Bug bashes/);
  assert.match(md, /No active bashes\./);
});

test('index: lists active bashes in table', () => {
  const root = mkroot();
  initBash({ root, slug: 'auth-2026-04-15', title: 'Auth feature' });
  initBash({ root, slug: 'billing-2026-04-15', title: 'Billing' });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /## Active/);
  assert.match(md, /auth-2026-04-15.*Auth feature.*ingest.*active/);
  assert.match(md, /billing-2026-04-15.*Billing.*ingest.*active/);
});

test('index: separates complete from active', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S1' });
  initBash({ root, slug: 's2', title: 'S2' });
  updateBash({ root, slug: 's2', path: 'status', value: 'complete' });
  setPhase({ root, slug: 's2', phase: 'complete' });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /## Active[\s\S]+s1/);
  assert.match(md, /## Complete[\s\S]+s2/);
});

test('index: ignores non-bash subdirs (archive/, etc.)', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S1' });
  mkdirSync(join(root, '.bb', 'archive'), { recursive: true });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.doesNotMatch(md, /\barchive\b.*active/);
});

test('index: malformed bash.json throws error naming the file', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S1' });
  writeFileSync(join(root, '.bb', 's1', 'bash.json'), 'not valid json');
  assert.throws(
    () => regenerateIndex({ root }),
    /malformed bash\.json at .*s1.bash\.json/,
  );
});
