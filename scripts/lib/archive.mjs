import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PROTECTED = new Set(['bash.json', 'STATUS.md']);

function tsDir() {
  // safe for filesystem: replace colons with dashes
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

export function archiveToHistory({ root, slug, files }) {
  const bashDir = join(root, '.bb', slug);
  const histRoot = join(bashDir, '.history', tsDir());
  mkdirSync(histRoot, { recursive: true });

  for (const rel of files) {
    if (PROTECTED.has(rel) || PROTECTED.has(rel.split('/').pop())) {
      throw new Error(`protected file refused for archive: ${rel}`);
    }
    const src = join(bashDir, rel);
    if (!existsSync(src)) throw new Error(`not found: ${rel}`);
    const dst = join(histRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
  return histRoot;
}
