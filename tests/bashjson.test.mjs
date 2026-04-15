import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash, readBash, updateBash, setPhase } from '../scripts/lib/bashjson.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-json-')); }

test('init: creates .bb/<slug>/bash.json with defaults', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  const raw = readFileSync(join(root, '.bb', 's1', 'bash.json'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.slug, 's1');
  assert.equal(obj.title, 'Test');
  assert.equal(obj.current_phase, 'ingest');
  assert.equal(obj.status, 'active');
  assert.ok(obj.created_at);
});

test('init: refuses to overwrite existing bash', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  assert.throws(() => initBash({ root, slug: 's1', title: 'Test' }), /already exists/);
});

test('read: round-trips', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  const obj = readBash({ root, slug: 's1' });
  assert.equal(obj.slug, 's1');
});

test('update: whitelist enforced', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  updateBash({ root, slug: 's1', path: 'status', value: 'paused' });
  assert.equal(readBash({ root, slug: 's1' }).status, 'paused');
  assert.throws(() => updateBash({ root, slug: 's1', path: 'slug', value: 'new' }), /not updatable/);
});

test('update: validates result against schema', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  assert.throws(() => updateBash({ root, slug: 's1', path: 'status', value: 'bogus' }), /invalid/);
});

test('setPhase: advances phase and validates', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  setPhase({ root, slug: 's1', phase: 'setup' });
  assert.equal(readBash({ root, slug: 's1' }).current_phase, 'setup');
  assert.throws(() => setPhase({ root, slug: 's1', phase: 'bogus' }), /invalid/);
});
