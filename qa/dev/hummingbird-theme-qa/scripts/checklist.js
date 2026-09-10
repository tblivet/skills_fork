#!/usr/bin/env node
'use strict';
//
// Reads the Hummingbird testing checklist and turns it into the list of things a
// campaign has to answer for.
//
//   node checklist.js --theme=<hummingbird folder> [--ref=<tag>] [--out=checklist.json]
//   node checklist.js --diff <old.json> <new.json>
//
// The checklist decides what gets tested, so this file only reads it. It never
// adds a test, drops one, or carries a copy of its own.
//
// Reasoning goes to stderr, the one result to stdout.
// Exit 0 read, 2 could not read it, 64 wrong arguments.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FILE = 'docs/qa/testing-checklist.md';

// A table is a list of tests when its first column says so. Everything else in
// the checklist is reference material: product types, breakpoints, the severity
// table, the sources the checklist is derived from. Getting this wrong silently
// adds or drops dozens of tests, so the decision is printed for every table.
const TEST_TABLE_HEADERS = ['module', 'setting', 'bo tab'];

const say = (...m) => console.error(...m);
const die = (m) => { console.error(`cannot read the checklist: ${m}`); process.exit(2); };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- where it came from
//
// A release tag is a fixed thing: two people testing the same release read the
// same checklist, and a repeat run months later reads it again unchanged. A
// branch or a working copy is not, so when that is all there is, the report has
// to say so.
function readChecklist(theme, wantedRef) {
  if (!fs.existsSync(path.join(theme, '.git')) && !fs.existsSync(path.join(theme, FILE))) {
    die(`${theme} does not look like a Hummingbird checkout, no ${FILE} and no git in it`);
  }

  const yml = path.join(theme, 'config', 'theme.yml');
  let version = null;
  if (fs.existsSync(yml)) {
    const m = fs.readFileSync(yml, 'utf8').match(/^version:\s*["']?([^"'\s]+)/m);
    if (m) version = m[1];
  }

  const tried = [];
  const fromRef = (ref, kind) => {
    const text = git(theme, ['show', `${ref}:${FILE}`]);
    tried.push(`${ref}: ${text ? 'found' : 'not there'}`);
    return text ? { text, source: { kind, ref, path: FILE } } : null;
  };

  if (wantedRef) {
    const got = fromRef(wantedRef, 'tag');
    if (!got) die(`${wantedRef} does not carry ${FILE}. Tried:\n  ${tried.join('\n  ')}`);
    say(`checklist read from ${wantedRef}, which you named`);
    return { ...got, themeVersion: version };
  }

  if (version) {
    for (const ref of [`v${version}`, version]) {
      const got = fromRef(ref, 'tag');
      if (got) {
        say(`checklist read from the release tag ${ref}, matching theme ${version}`);
        return { ...got, themeVersion: version };
      }
    }
  }

  const file = path.join(theme, FILE);
  if (!fs.existsSync(file)) {
    die(`no release tag carries ${FILE} and it is not in the working copy either. Tried:\n  ${tried.join('\n  ')}`);
  }
  const branch = (git(theme, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || null;
  const dirty = !!(git(theme, ['status', '--porcelain', '--', FILE]) || '').trim();
  say(`no release tag carries ${FILE}, so it was read from the working copy${branch ? ` on ${branch}` : ''}.`);
  say('That is a weaker basis than a tag, and the report says so on its front page.');
  return {
    text: fs.readFileSync(file, 'utf8'),
    source: { kind: 'working-copy', ref: branch, path: FILE, uncommittedChanges: dirty },
    themeVersion: version,
  };
}

// --------------------------------------------------------------------- parsing
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
const isSeparator = (line) => /^\|[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');

function parse(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const tables = [];
  let section = null;
  // A section that declares every one of its points a shop setting means its
  // sub-sections too: the declaration sits in "## 4." and the points live in
  // "### 4.1". Keep the declaring ids and let them apply downwards.
  const configSections = [];
  const declaredConfig = (id) =>
    configSections.some((c) => id === c || id.startsWith(`${c}.`));

  const newSection = (id, title) => {
    section = { id, title, items: [] };
    sections.push(section);
  };
  newSection('0', 'Preamble');

  const push = (unit, textRaw, extra = {}) => {
    const t = textRaw.trim();
    if (!t) return;
    const n = section.items.length + 1;
    section.items.push({
      id: `${section.id}/${String(n).padStart(2, '0')}`,
      n,
      unit,
      text: t,
      textSha256: sha(t.toLowerCase().replace(/\s+/g, ' ')),
      config: /\(config\)/i.test(t),
      ...extra,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const head = line.match(/^(#{2,4})\s+(.*)$/);
    if (head) {
      const title = head[2].trim();
      const num = title.match(/^(\d+(?:\.\d+)*)\.?\s+(.*)$/);
      if (num) newSection(num[1], num[2]);
      continue;
    }

    // The checklist says it once, in prose, when a whole section changes shop
    // settings. Read that rather than keeping our own list of which sections do.
    // Two ways a section says it changes shop settings. The blunt one names
    // itself; the quiet one just mentions (config) in its opening prose, the way
    // 3.7 does when it turns a feature flag on for the whole section. Take both,
    // and print which line decided it: over-flagging costs one reading of a
    // setting, under-flagging leaves the shop altered for every later section.
    if (/everything in this section is\s*\*\*\(config\)\*\*/i.test(line)) {
      if (!configSections.includes(section.id)) {
        configSections.push(section.id);
        say(`section ${section.id} declares every one of its points a shop setting, sub-sections included`);
      }
      continue;
    }
    if (/\(config\)/i.test(line) && !/^\s*[-*]\s+\[/.test(line) && !line.trim().startsWith('|')
        && section.id !== '0' && !configSections.includes(section.id)) {
      configSections.push(section.id);
      say(`section ${section.id} changes a shop setting in its own words, so all of it is treated as one:`);
      say(`    ${line.trim().slice(0, 100)}`);
      continue;
    }

    const box = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (box) { push('checkbox', box[2]); continue; }

    if (line.trim().startsWith('|') && lines[i + 1] && isSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const first = (header[0] || '').toLowerCase();
      const isTest = TEST_TABLE_HEADERS.includes(first);
      const table = {
        section: section.id,
        header,
        kind: isTest ? 'check' : 'reference',
        why: isTest
          ? `its first column is "${header[0]}", which lists things to test`
          : `its first column is "${header[0]}", which is not a list of things to test`,
        rows: 0,
      };
      tables.push(table);

      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        const cells = splitRow(lines[j]);
        table.rows++;
        if (isTest) {
          const columns = {};
          header.forEach((h, k) => { columns[h] = cells[k] || ''; });
          push('table-row', `${cells[0]}: ${cells.slice(1).join(' - ')}`, {
            table: `${section.id}#${tables.length}`,
            columns,
          });
        }
        j++;
      }
      i = j - 1;
    }
  }

  for (const sec of sections) {
    if (!declaredConfig(sec.id)) continue;
    for (const it of sec.items) it.config = true;
  }

  return {
    sections: sections.filter((s) => s.items.length),
    tables,
    configSections,
  };
}

// ------------------------------------------------------------------- comparing
//
// Numbering a point by its position is a trap: add one line at the top of a
// section and every number below it shifts, quietly attaching yesterday's
// results to the wrong test. So items are matched on their text first.
function diff(oldFile, newFile) {
  const a = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  const b = JSON.parse(fs.readFileSync(newFile, 'utf8'));
  const flat = (c) => c.sections.flatMap((s) => s.items);
  const byText = (items) => new Map(items.map((i) => [i.textSha256, i]));
  const A = flat(a);
  const B = flat(b);
  const ma = byText(A);
  const mb = byText(B);

  const added = B.filter((i) => !ma.has(i.textSha256));
  const removed = A.filter((i) => !mb.has(i.textSha256));
  const moved = B.filter((i) => ma.has(i.textSha256) && ma.get(i.textSha256).id !== i.id)
    .map((i) => ({ was: ma.get(i.textSha256).id, now: i.id, text: i.text }));

  const out = { added, removed, moved,
    summary: `${added.length} added, ${removed.length} removed, ${moved.length} moved` };
  say(out.summary);
  for (const m of moved) say(`  moved ${m.was} -> ${m.now}  ${m.text.slice(0, 60)}`);
  for (const m of added) say(`  added ${m.id}  ${m.text.slice(0, 60)}`);
  for (const m of removed) say(`  gone  ${m.id}  ${m.text.slice(0, 60)}`);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ----------------------------------------------------------------------- main
function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--diff') {
    if (argv.length < 3) { say('usage: checklist.js --diff <old.json> <new.json>'); process.exit(64); }
    return diff(argv[1], argv[2]);
  }

  const theme = arg('theme');
  if (!theme) {
    say('usage: checklist.js --theme=<hummingbird folder> [--ref=<tag>] [--out=checklist.json]');
    say('       checklist.js --diff <old.json> <new.json>');
    process.exit(64);
  }

  const read = readChecklist(path.resolve(theme), arg('ref'));
  const { sections, tables, configSections } = parse(read.text);

  for (const t of tables) {
    say(`  table in ${t.section}, ${t.rows} rows: ${t.kind === 'check' ? 'TESTS' : 'reference'} (${t.why})`);
  }

  const items = sections.flatMap((s) => s.items);
  const counts = {
    total: items.length,
    checkbox: items.filter((i) => i.unit === 'checkbox').length,
    tableRow: items.filter((i) => i.unit === 'table-row').length,
    config: items.filter((i) => i.config).length,
    testTables: tables.filter((t) => t.kind === 'check').length,
    referenceTables: tables.filter((t) => t.kind === 'reference').length,
    sections: sections.length,
  };

  const out = {
    source: read.source,
    themeVersion: read.themeVersion,
    sha256: sha(read.text),
    readAt: new Date().toISOString(),
    counts,
    configSections,
    tables,
    sections,
  };

  say('');
  say(`${counts.total} points to answer for, across ${counts.sections} sections:`);
  say(`  ${counts.checkbox} tick boxes`);
  say(`  ${counts.tableRow} rows in the ${counts.testTables} tables that list tests`);
  say(`  ${counts.config} of them change a shop setting and have to be put back`);
  say(`  ${counts.referenceTables} tables read as reference, not as tests`);

  const dest = arg('out');
  if (dest) {
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    say(`written to ${dest}`);
    process.stdout.write(path.resolve(dest) + '\n');
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

main();
