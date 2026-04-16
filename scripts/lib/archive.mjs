import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

const PROTECTED = new Set(['bash.json', 'STATUS.md']);

function tsDir() {
  // filesystem-safe: colons and dot become dashes; random suffix guarantees uniqueness under tight succession
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

export function archiveToHistory({ root, slug, files }) {
  const bashDir = join(root, '.bb', slug);

  const pairs = [];
  for (const rel of files) {
    if (PROTECTED.has(rel) || PROTECTED.has(rel.split('/').pop())) {
      throw new Error(`protected file refused for archive: ${rel}`);
    }
    const src = join(bashDir, rel);
    if (!existsSync(src)) throw new Error(`not found: ${rel}`);
    pairs.push({ rel, src });
  }

  const histRoot = join(bashDir, '.history', tsDir());
  mkdirSync(histRoot, { recursive: true });
  for (const { rel, src } of pairs) {
    const dst = join(histRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
  return histRoot;
}
