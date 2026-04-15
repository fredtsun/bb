import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plugin manifest is valid', async () => {
  const raw = await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, 'bb');
  assert.ok(manifest.description && manifest.description.length > 0);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.author && manifest.author.name);
});
