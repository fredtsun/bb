import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function regenerateIndex({ root }) {
  const bbDir = join(root, '.bb');
  mkdirSync(bbDir, { recursive: true });
  const entries = readdirSync(bbDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'archive')
    .map(e => join(bbDir, e.name, 'bash.json'))
    .filter(p => existsSync(p))
    .map(p => JSON.parse(readFileSync(p, 'utf8')));

  const active = entries.filter(b => b.status === 'active' || b.status === 'paused');
  const complete = entries.filter(b => b.status === 'complete');
  const abandoned = entries.filter(b => b.status === 'abandoned');

  const rowsFor = (list) =>
    list.length === 0
      ? '_None._'
      : [
          '| Slug | Title | Phase | Status | Created |',
          '|------|-------|-------|--------|---------|',
          ...list.map(b => `| ${b.slug} | ${b.title} | ${b.current_phase} | ${b.status} | ${b.created_at} |`),
        ].join('\n');

  const md = [
    '# Bug bashes',
    '',
    '## Active',
    active.length === 0 ? 'No active bashes.' : rowsFor(active),
    '',
    '## Complete',
    rowsFor(complete),
    '',
    '## Abandoned',
    rowsFor(abandoned),
    '',
  ].join('\n');
  const path = join(bbDir, 'INDEX.md');
  writeFileSync(path, md);
  return path;
}
