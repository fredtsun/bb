import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBashJson } from './validate.mjs';

// whitelist of top-level keys updateBash is allowed to change
const UPDATABLE = new Set([
  'status',
  'connectors_used',
  'dispatch_summary',
  'finding_counts',
  'retest_cycles',
]);

function bashDir(root, slug) { return join(root, '.bb', slug); }
function bashFile(root, slug) { return join(bashDir(root, slug), 'bash.json'); }

export function readBash({ root, slug }) {
  const file = bashFile(root, slug);
  if (!existsSync(file)) throw new Error(`no bash session found for slug: ${slug}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeValidated(root, slug, obj) {
  const { valid, errors } = validateBashJson(obj);
  if (!valid) throw new Error(`invalid bash.json: ${JSON.stringify(errors)}`);
  mkdirSync(bashDir(root, slug), { recursive: true });
  writeFileSync(bashFile(root, slug), JSON.stringify(obj, null, 2) + '\n');
}

export function initBash({ root, slug, title }) {
  if (existsSync(bashFile(root, slug))) throw new Error(`bash already exists: ${slug}`);
  const obj = {
    slug, title,
    created_at: new Date().toISOString(),
    current_phase: 'ingest',
    status: 'active',
  };
  writeValidated(root, slug, obj);
  return obj;
}

export function updateBash({ root, slug, path, value }) {
  if (!UPDATABLE.has(path)) throw new Error(`field not updatable: ${path}`);
  const obj = readBash({ root, slug });
  obj[path] = value;
  writeValidated(root, slug, obj);
  return obj;
}

export function setPhase({ root, slug, phase }) {
  const obj = readBash({ root, slug });
  obj.current_phase = phase;
  writeValidated(root, slug, obj);
  return obj;
}
