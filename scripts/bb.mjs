#!/usr/bin/env node
import { deriveSlug } from './lib/slug.mjs';

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

const handlers = {
  slug(args) {
    const { flags, positional } = parseFlags(args);
    const [title] = positional;
    if (!title) { console.error('usage: bb slug <title> [--date YYYY-MM-DD] [--root <dir>]'); process.exit(2); }
    const root = flags.root ?? process.cwd();
    const date = flags.date ?? today();
    process.stdout.write(deriveSlug(title, { date, root }) + '\n');
  },
};

const handler = handlers[sub];
if (!handler) {
  console.error(`unknown subcommand: ${sub ?? '(none)'}`);
  console.error('available: ' + Object.keys(handlers).join(', '));
  process.exit(2);
}
handler(rest);
