import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash } from '../scripts/lib/bashjson.mjs';
import { archiveToHistory } from '../scripts/lib/archive.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-arch-')); }

test('archive: moves files into .history/<ts>/ preserving structure', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  const dir = join(root, '.bb', 's1');
  writeFileSync(join(dir, 'context.md'), 'CTX');
  writeFileSync(join(dir, 'setup.md'), 'SETUP');
  mkdirSync(join(dir, 'findings'), { recursive: true });
  writeFileSync(join(dir, 'findings', 'F001.md'), 'FND');

  const histDir = archiveToHistory({ root, slug: 's1', files: ['context.md', 'setup.md', 'findings/F001.md'] });
  // histDir should exist under .history/<ts>/
  assert.ok(existsSync(histDir));
  assert.equal(readFileSync(join(histDir, 'context.md'), 'utf8'), 'CTX');
  assert.equal(readFileSync(join(histDir, 'setup.md'), 'utf8'), 'SETUP');
  assert.equal(readFileSync(join(histDir, 'findings', 'F001.md'), 'utf8'), 'FND');
  // originals gone
  assert.equal(existsSync(join(dir, 'context.md')), false);
  assert.equal(existsSync(join(dir, 'setup.md')), false);
  assert.equal(existsSync(join(dir, 'findings', 'F001.md')), false);
});

test('archive: refuses to move bash.json or STATUS.md', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['bash.json'] }), /protected/);
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['STATUS.md'] }), /protected/);
});

test('archive: error on missing file', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['does-not-exist.md'] }), /not found/);
});

test('archive: two archive calls go to distinct timestamp dirs', async () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  writeFileSync(join(root, '.bb', 's1', 'a.md'), '1');
  writeFileSync(join(root, '.bb', 's1', 'b.md'), '2');
  const h1 = archiveToHistory({ root, slug: 's1', files: ['a.md'] });
  // small wait to force different ISO second (timestamp sanitized into dir name)
  await new Promise(r => setTimeout(r, 1100));
  const h2 = archiveToHistory({ root, slug: 's1', files: ['b.md'] });
  assert.notEqual(h1, h2);
});
