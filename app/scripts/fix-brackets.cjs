#!/usr/bin/env node
/* eslint-disable no-console */
// Repair pass: restore the missing `[]` brackets around `var(--token)` in
// Tailwind arbitrary-value classes. Triggered by an earlier replacement that
// emitted `border-var(--border)` instead of `border-[var(--border)]`.
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || 'D:/Projects/Agent_LLM/app/src';

const PREFIXES = [
  'bg','text','border','border-x','border-y','border-t','border-b','border-l','border-r',
  'divide','divide-x','divide-y',
  'from','to','via',
  'outline',
  'decoration',
  'ring','ring-offset',
  'placeholder','caret','accent','fill','stroke',
  'shadow',
];
const re = new RegExp(
  '\\b(' + PREFIXES.join('|') + ')-(var\\(--[a-z0-9-]+\\))(?=[\\s"\'`/]|$)',
  'g'
);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

let total = 0, files = 0;
for (const f of walk(ROOT)) {
  const content = fs.readFileSync(f, 'utf8');
  let replaced = '';
  let last = 0;
  let hits = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    replaced += content.slice(last, m.index) + m[1] + '-[' + m[2] + ']';
    last = m.index + m[0].length;
    hits++;
  }
  if (hits > 0) {
    replaced += content.slice(last);
    fs.writeFileSync(f, replaced, 'utf8');
    files++;
    total += hits;
    console.log(`repaired: ${f.slice(ROOT.length + 1)} (${hits} hits)`);
  }
}
console.log('\nfiles touched: ' + files + ', repairs: ' + total);
