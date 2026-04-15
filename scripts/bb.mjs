#!/usr/bin/env node
import { deriveSlug } from './lib/slug.mjs';
import { readFile } from 'node:fs/promises';
import { validateBashJson } from './lib/validate.mjs';
import { initBash, readBash, updateBash, setPhase } from './lib/bashjson.mjs';

const [sub, ...rest] = process.argv.slice(2);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { flags, positional };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function tryParseJson(s) {
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s);
  try { return JSON.parse(s); } catch { return s; }
}

const handlers = {
  slug(args) {
    const { flags, positional } = parseFlags(args);
    const [title] = positional;
    if (!title) { console.error('usage: bb slug <title> [--date YYYY-MM-DD] [--root <dir>]'); process.exit(2); }
    const root = flags.root ?? process.cwd();
    const date = flags.date ?? today();
    process.stdout.write(deriveSlug(title, { date, root }) + '\n');
  },
  init(args) {
    const { flags, positional } = parseFlags(args);
    const [slug, title] = positional;
    if (!slug || !title) { console.error('usage: bb init <slug> <title> [--root <dir>]'); process.exit(2); }
    const root = flags.root ?? process.cwd();
    initBash({ root, slug, title });
    process.stdout.write(slug + '\n');
  },
  json(args) {
    const [op, ...rest] = args;
    const { flags, positional } = parseFlags(rest);
    const root = flags.root ?? process.cwd();
    if (op === 'get') {
      const [slug] = positional;
      if (!slug) { console.error('usage: bb json get <slug> [--root <dir>]'); process.exit(2); }
      try { process.stdout.write(JSON.stringify(readBash({ root, slug }), null, 2) + '\n'); }
      catch (err) { console.error(`error: ${err.message}`); process.exit(1); }
    } else if (op === 'set') {
      const [slug, path, rawValue] = positional;
      if (!slug || !path || rawValue === undefined) {
        console.error('usage: bb json set <slug> <key> <value> [--root <dir>]');
        process.exit(2);
      }
      let value;
      try { value = tryParseJson(rawValue); }
      catch (err) { console.error(`error: invalid JSON value: ${err.message}`); process.exit(1); }
      process.stdout.write(JSON.stringify(updateBash({ root, slug, path, value }), null, 2) + '\n');
    } else {
      console.error('usage: bb json <get|set> ...'); process.exit(2);
    }
  },
  phase(args) {
    const { flags, positional } = parseFlags(args);
    const [slug, phase] = positional;
    if (!slug || !phase) { console.error('usage: bb phase <slug> <phase> [--root <dir>]'); process.exit(2); }
    const root = flags.root ?? process.cwd();
    process.stdout.write(JSON.stringify(setPhase({ root, slug, phase }), null, 2) + '\n');
  },
  async validate(args) {
    const { positional } = parseFlags(args);
    const [file] = positional;
    if (!file) { console.error('usage: bb validate <bash.json>'); process.exit(2); }
    let obj;
    try {
      obj = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') console.error(`error: file not found: ${file}`);
      else console.error(`error: invalid JSON in ${file}: ${err.message}`);
      process.exit(1);
    }
    const { valid, errors } = validateBashJson(obj);
    if (valid) { process.stdout.write('ok\n'); return; }
    console.error('invalid:', JSON.stringify(errors, null, 2));
    process.exit(1);
  },
};

async function main() {
  const handler = handlers[sub];
  if (!handler) {
    console.error(`unknown subcommand: ${sub ?? '(none)'}`);
    console.error('available: ' + Object.keys(handlers).join(', '));
    process.exit(2);
  }
  await handler(rest);
}

main().catch(err => { console.error(err); process.exit(1); });
