#!/usr/bin/env node
'use strict';
//
// Records one answer to one checklist point that no browser made: something a
// command decided, or something a person looked at and judged.
//
//   node observe.js --out=<campaign>/suites/1 --label=pass --profile=b2c --viewport=desktop \
//     --item=1.1/02 --outcome=pass --by=command \
//     --assertion='the linters and Prettier both finished clean' \
//     --evidence=lint.txt
//
// It goes through the same door as everything the browser records, so the report
// counts it the same way and shows who said it.
//
// Exit 0 recorded, 2 refused, 64 wrong arguments.

const fs = require('fs');
const path = require('path');
const { OUTCOMES, arg } = require('./record.js');

const BY = ['machine', 'command', 'human'];

function usage(why) {
  if (why) console.error(why);
  console.error('usage: observe.js --out=<folder> --item=<3.2/07> --outcome=<' + Object.keys(OUTCOMES).join('|') + '>');
  console.error('       [--label=pass] [--profile=b2c] [--viewport=desktop] [--by=command|human|machine]');
  console.error('       [--assertion=...] [--detail=...] [--reason=...] [--evidence=file,file]');
  process.exit(64);
}

const outRoot = arg('out') && path.resolve(arg('out'));
const label = arg('label', 'pass');
const profile = arg('profile', 'b2c');
const viewport = arg('viewport', 'desktop');
const item = arg('item');
const outcome = arg('outcome');
const by = arg('by', 'human');
const assertion = arg('assertion');
const detail = arg('detail');
const reason = arg('reason');
const evidence = (arg('evidence') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!outRoot) usage('--out is required');
if (!item) usage('--item is required: which checklist point this answers');
if (!(outcome in OUTCOMES)) usage(`--outcome must be one of ${Object.keys(OUTCOMES).join(', ')}`);
if (!BY.includes(by)) usage(`--by must be one of ${BY.join(', ')}`);

// The same rules the browser runs under. A pass with nothing recorded about what
// was checked is not evidence, wherever it came from.
if (outcome === 'pass' && !assertion) {
  console.error(`refusing: ${item} would be recorded as passing without saying what was checked`);
  process.exit(2);
}
if ((outcome === 'skipped' || outcome === 'inconclusive') && !reason) {
  console.error(`refusing: ${item} would be recorded as ${outcome} without a reason`);
  process.exit(2);
}
if (outcome === 'needs-human' && !evidence.length && !detail) {
  console.error(`refusing: ${item} would be left to a person with nothing for them to look at`);
  process.exit(2);
}

const dir = path.join(outRoot, label, `${profile}-${viewport}`);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'run.json');

const missing = evidence.filter((e) => !fs.existsSync(path.join(dir, e)));
if (missing.length) {
  console.error(`refusing: the evidence named is not in ${dir}: ${missing.join(', ')}`);
  console.error('put the file there first, so the report can point at something that exists');
  process.exit(2);
}

// A folder the browser has not written yet still gets a run.json, so a section
// answered entirely by commands or by a person is a section like any other.
const run = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : {
      suite: path.basename(outRoot), section: path.basename(outRoot),
      label, profile, viewport, probe: 'none',
      startedAt: new Date().toISOString(),
      observations: [], steps: [], settingsChanged: [],
      consoleErrors: [], netErrors: [], notes: [], harness: [],
    };

run.observations.push({
  item, outcome, by, assertion: assertion || null, detail: detail || null,
  reason: reason || null, measurement: null, evidence, step: null,
  at: new Date().toISOString(),
});
run.finishedAt = new Date().toISOString();

fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\n');
console.error(`recorded: ${item} ${outcome}, said by ${by}`);
console.error(`  ${assertion || reason || detail || ''}`);
process.stdout.write(file + '\n');
