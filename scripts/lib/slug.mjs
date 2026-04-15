import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function deriveSlug(title, { date, root }) {
  const kebab = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!kebab) throw new Error(`cannot derive slug from empty title: "${title}"`);

  const base = `${kebab}-${date}`;
  let candidate = base;
  let n = 2;
  while (existsSync(join(root, '.bb', candidate))) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}
