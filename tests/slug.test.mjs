import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSlug } from '../scripts/lib/slug.mjs';

test('slug: basic kebab', () => {
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root: tmpdir() }),
               'auth-feature-2026-04-15');
});

test('slug: punctuation collapses to single dash', () => {
  assert.equal(deriveSlug('Billing!! v2', { date: '2026-04-15', root: tmpdir() }),
               'billing-v2-2026-04-15');
});

test('slug: leading/trailing junk trimmed', () => {
  assert.equal(deriveSlug('  ---Auth---  ', { date: '2026-04-15', root: tmpdir() }),
               'auth-2026-04-15');
});

test('slug: collision appends numeric suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-slug-'));
  mkdirSync(join(root, '.bb', 'auth-feature-2026-04-15'), { recursive: true });
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root }),
               'auth-feature-2026-04-15-2');
  mkdirSync(join(root, '.bb', 'auth-feature-2026-04-15-2'));
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root }),
               'auth-feature-2026-04-15-3');
});

test('slug: empty title throws', () => {
  assert.throws(() => deriveSlug('   ', { date: '2026-04-15', root: tmpdir() }),
                /empty title/);
});
