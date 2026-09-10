#!/usr/bin/env node
'use strict';
//
// Reads the shop's settings and hashes them, so a campaign can tell that the
// shop it is measuring is still the shop it measured last time.
//
//   node fingerprint.js --sql='<command that reads SQL on stdin>' --out=settings.json
//   node fingerprint.js --sql='...' --compare=settings.json
//
// The command is yours to give: this skill runs on Flashlight, on the official
// PrestaShop image, or on anything else, so it never assumes a container name, a
// user or a database. Whatever you pass is run as is, and is NEVER written to
// any output file, because it carries a password.
//
//   --sql='docker exec -i <db container> mariadb -u<user> <database> -N -B'
//   --sql='mysql -h 127.0.0.1 -P 8888 -u <user> -p<password> <database> -N -B'
//
// Exit 0 read, 1 the shop moved (with --compare), 2 could not read it, 64 wrong arguments.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const say = (...m) => console.error(...m);
const die = (m) => { console.error(`cannot read the shop settings: ${m}`); process.exit(2); };

// Nothing is ignored by default. Measured on a running shop, ordinary browsing
// moves no setting at all, so a guessed ignore list would only have hidden real
// drift. An entry is earned instead: when a reading reports a setting that moved
// with nobody touching it, add it to the campaign's own ignore file with the
// reason, and it shows up in the report as a stated exception.
//
//   --ignore=<file>   one JSON object: { "PS_SOMETHING": "why it moves by itself" }
function loadIgnores(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) return {};
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [k, why] of Object.entries(map)) {
    if (!why || typeof why !== 'string') {
      die(`the ignore file gives no reason for ${k}. A setting is only left out with a reason`);
    }
  }
  return map;
}

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function query(sqlCommand, sql) {
  try {
    return execSync(sqlCommand, { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
                                  stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const why = String((e.stderr || e.message || '')).split('\n')[0];
    die(`the command you gave did not answer. ${why}`);
  }
}

// mysql and mariadb in batch mode escape a tab, a newline and a backslash inside
// a value, so a serialised setting cannot be mistaken for extra columns.
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

function discoverPrefix(sqlCommand) {
  const out = query(sqlCommand, "SHOW TABLES LIKE '%configuration';\n");
  const names = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const exact = names.filter((n) => n.endsWith('configuration'));
  if (!exact.length) die('no configuration table found. Is that the shop database?');
  const prefix = exact[0].slice(0, exact[0].length - 'configuration'.length);
  say(`table prefix read from the database: ${prefix || '(none)'}`);
  return prefix;
}

function readSettings(sqlCommand, ignores) {
  const prefix = discoverPrefix(sqlCommand);
  const sql = `SELECT name, IFNULL(id_shop_group, 0), IFNULL(id_shop, 0), IFNULL(value, '')
               FROM ${prefix}configuration ORDER BY name, id_shop_group, id_shop;\n`;
  const rows = query(sqlCommand, sql).split('\n').filter((l) => l.length);

  const settings = {};
  const ignored = [];
  for (const line of rows) {
    const cells = line.split('\t');
    if (cells.length < 4) continue;
    const [name, group, shop] = cells;
    const value = unescape(cells.slice(3).join('\t'));
    const key = shop !== '0' ? `${name}@shop${shop}` : group !== '0' ? `${name}@group${group}` : name;
    if (ignores[name] || ignores[key]) { ignored.push(key); continue; }
    settings[key] = value;
  }
  return { prefix, settings, ignored: ignored.sort() };
}

const hashOf = (settings) =>
  crypto.createHash('sha256')
    .update(Object.keys(settings).sort().map((k) => `${k}=${settings[k]}`).join('\n'), 'utf8')
    .digest('hex');

function compare(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) added.push({ key: k, now: after[k] });
    else if (before[k] !== after[k]) changed.push({ key: k, was: before[k], now: after[k] });
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push({ key: k, was: before[k] });
  return { changed, added, removed };
}

const short = (v) => (v == null ? '(missing)' : v.length > 40 ? `${v.slice(0, 40)}...` : v);

function main() {
  const sqlCommand = arg('sql');
  if (!sqlCommand) {
    say("usage: fingerprint.js --sql='<command that reads SQL on stdin>' [--out=file] [--compare=file]");
    say('       the command is never written to any file, because it carries a password');
    process.exit(64);
  }

  const ignores = loadIgnores(arg('ignore'));
  const { prefix, settings, ignored } = readSettings(sqlCommand, ignores);
  const fingerprint = hashOf(settings);
  say(`${Object.keys(settings).length} settings read`);
  if (ignored.length) {
    say(`${ignored.length} left out, each with a stated reason:`);
    for (const k of ignored) say(`  ${k}: ${ignores[k.split('@')[0]] || ignores[k]}`);
  }
  say(`fingerprint ${fingerprint.slice(0, 12)}`);

  const against = arg('compare');
  if (against) {
    const old = JSON.parse(fs.readFileSync(against, 'utf8'));
    if (old.fingerprint === fingerprint) {
      say('the shop is the one that was measured before, unchanged');
      process.exit(0);
    }
    const d = compare(old.settings || {}, settings);
    say('');
    say('THE SHOP HAS MOVED since that reading. What differs:');
    for (const c of d.changed) say(`  changed  ${c.key}: ${short(c.was)} -> ${short(c.now)}`);
    for (const c of d.added)   say(`  new      ${c.key}: ${short(c.now)}`);
    for (const c of d.removed) say(`  gone     ${c.key}: was ${short(c.was)}`);
    say('');
    say('Results measured before and after this are not about the same shop.');
    // Names only. A settings table holds the merchant's email address and can
    // hold credentials, and this result is what the report is built from.
    process.stdout.write(JSON.stringify({
      fingerprint,
      was: old.fingerprint,
      changed: d.changed.map((c) => c.key),
      added: d.added.map((c) => c.key),
      removed: d.removed.map((c) => c.key),
    }, null, 2) + '\n');
    process.exit(1);
  }

  // The command that read this is deliberately absent from what gets written.
  const out = {
    readAt: new Date().toISOString(),
    prefix,
    fingerprint,
    count: Object.keys(settings).length,
    ignoredWithAReason: ignored,
    // Keep this file in the campaign folder. It holds the merchant's email
    // address and may hold credentials, so it never goes into a published report.
    settings,
  };
  const dest = arg('out');
  if (dest) {
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    say(`written to ${dest}`);
    process.stdout.write(path.resolve(dest) + '\n');
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

main();
