'use strict';
//
// The rules every run shares, kept in one file so they cannot drift apart:
// what an answer to a checklist point looks like, what may be called a pass,
// what a run leaves behind, and what its exit code means.
//
// Nothing here decides anything about the theme. A run records; the report
// works out what the recording means.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// What a single reading of a single checklist point can come to.
const OUTCOMES = {
  pass: 'the check was made and it holds',
  fail: 'the check was made and it does not hold',
  'needs-human': 'measured, but only a person can say whether it is right',
  inconclusive: 'the reading itself could not be trusted',
  skipped: 'not attempted here, with a reason',
};

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sha256File = (f) => sha256(fs.readFileSync(f, 'utf8'));

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

// A probe is whatever actually looks at the shop. It hands back a way to settle
// and a way to capture, and knows nothing about checklist points.
//   probe = { name, runnerFile, settle?, capture?, meta? }
function startSuite({ suite, section, out, label, profile, viewport, checklist, probe, only }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const rec = {
    observations: [],
    steps: [],
    settingsChanged: [],
    fixtures: [],
    consoleErrors: [],
    netErrors: [],
    notes: [],
    harness: [],
  };
  const state = { stepNo: 0, startedAt: new Date().toISOString() };
  // Comparing against an older theme version only asks about the points that
  // turned something up. The suite file still runs whole, because the steps
  // before a check are how the shop gets into the state the check needs; only
  // the answers outside the list are dropped, and the list is recorded so the
  // report never reads a narrow re-run as a full one.
  const wanted = only && only.length ? new Set(only) : null;

  const note = (text) => { rec.notes.push(String(text)); console.error(`  note: ${text}`); };
  const fault = (text) => { rec.harness.push(String(text)); console.error(`  FAULT: ${text}`); };

  // The one rule that makes the report worth reading: a point is only green if a
  // check actually looked at it AND said what it looked for. A pass with no
  // assertion is not evidence, so it is refused here rather than discovered
  // later by the report.
  function observe(item, outcome, opts = {}) {
    const { assertion = null, measurement = null, evidence = [], by = 'machine',
            reason = null, detail = null } = opts;

    if (!item) return fault('an answer was recorded without saying which checklist point it answers');
    if (wanted && !wanted.has(item)) return null;
    if (!(outcome in OUTCOMES)) {
      return fault(`"${outcome}" is not something a check can come to. One of: ${Object.keys(OUTCOMES).join(', ')}`);
    }
    if (outcome === 'pass' && !assertion) {
      return fault(`${item} was recorded as passing without saying what was checked. That is not evidence`);
    }
    if ((outcome === 'skipped' || outcome === 'inconclusive') && !reason) {
      return fault(`${item} was recorded as ${outcome} without a reason`);
    }
    if (outcome === 'needs-human' && !evidence.length && measurement === null) {
      return fault(`${item} was left to a person with nothing for them to look at`);
    }

    const row = {
      item, outcome, by, assertion, detail, reason,
      measurement,
      evidence: evidence.filter(Boolean),
      step: state.stepNo || null,
      at: new Date().toISOString(),
    };
    rec.observations.push(row);
    const mark = { pass: 'ok', fail: 'FAIL', 'needs-human': 'look', inconclusive: '??', skipped: '--' }[outcome];
    console.error(`  [${mark}] ${item}  ${assertion || reason || ''}`);
    return row;
  }

  async function step(name, fn) {
    state.stepNo += 1;
    const n = String(state.stepNo).padStart(2, '0');
    const startedAt = Date.now();
    const before = rec.consoleErrors.length + rec.netErrors.length;
    console.error(`step ${n}: ${name}`);
    let threw = null;
    try {
      await fn();
    } catch (e) {
      threw = String((e && e.message) || e);
      fault(`step ${n} "${name}" stopped: ${threw}`);
    }
    if (probe.settle) { try { await probe.settle(); } catch { /* settling is best effort */ } }
    let shot = null;
    if (probe.capture) { try { shot = await probe.capture(n, name); } catch { shot = null; } }
    rec.steps.push({
      n, name, shot, ms: Date.now() - startedAt, threw,
      newProblems: rec.consoleErrors.length + rec.netErrors.length - before,
    });
    return !threw;
  }

  // Every shop-wide change is written down before it is made, not after: a run
  // that dies in the middle still has to leave a record of what to put back.
  function settingOpened({ setting, was, set, where }) {
    const entry = {
      seq: rec.settingsChanged.length + 1,
      setting, was, set, where: where || null,
      openedAt: new Date().toISOString(),
      restoredAt: null, state: 'open', restoreVerified: false,
    };
    rec.settingsChanged.push(entry);
    flush();               // on disk immediately, because the point is surviving a crash
    return entry;
  }

  function settingRestored(entry, readBack) {
    entry.restoredAt = new Date().toISOString();
    entry.readBack = readBack;
    entry.restoreVerified = String(readBack) === String(entry.was);
    entry.state = entry.restoreVerified ? 'restored' : 'restore-failed';
    if (!entry.restoreVerified) {
      fault(`${entry.setting} was put back to ${entry.was} but reads ${readBack}. A restore nobody could confirm is a failure`);
    }
    flush();
  }

  // Data made up for the test: a linked accessory, a return, a review. Written
  // down before it exists, like a setting, so a run that dies in the middle still
  // says what it left behind.
  //
  // Unlike a setting, a fixture does not always have to go. Some cannot: an order
  // is not un-placed. So a fixture ends either removed and confirmed, or left on
  // purpose with a reason, and the report prints both.
  function fixtureCreated({ what, how, id = null, why }) {
    if (!what) { fault('a fixture was recorded without saying what it is'); return null; }
    if (!why) { fault(`the fixture "${what}" was recorded without saying which checklist point needs it`); return null; }
    const entry = {
      seq: rec.fixtures.length + 1,
      what, how: how || null, id, why,
      createdAt: new Date().toISOString(),
      removedAt: null, state: 'present', leftBehindReason: null,
    };
    rec.fixtures.push(entry);
    flush();
    console.error(`  fixture: made ${what}${id ? ` (${id})` : ''}, for ${why}`);
    return entry;
  }

  function fixtureRemoved(entry, stillThere) {
    if (!entry) return;
    entry.removedAt = new Date().toISOString();
    entry.state = stillThere ? 'removal-failed' : 'removed';
    if (stillThere) fault(`the fixture "${entry.what}" was removed but is still there`);
    flush();
  }

  function fixtureLeft(entry, reason) {
    if (!entry) return;
    if (!reason) { fault(`the fixture "${entry.what}" was left behind without saying why`); return; }
    entry.state = 'left';
    entry.leftBehindReason = reason;
    flush();
    console.error(`  fixture: left ${entry.what} in place, because ${reason}`);
  }

  const body = (extra = {}) => ({
    suite, section, label, profile, viewport,
    selection: only && only.length ? only : null,
    selectionMode: wanted ? 'subset' : 'full',
    probe: probe.name,
    suiteSha256: state.suiteSha256 || null,
    runner: path.basename(probe.runnerFile),
    runnerSha256: sha256File(probe.runnerFile),
    recordSha256: sha256File(__filename),
    checklistSha256: checklist || null,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    ...(probe.meta ? probe.meta() : {}),
    ...extra,
    ...rec,
  });

  const file = path.join(out, 'run.json');
  const flush = (extra) => fs.writeFileSync(file, JSON.stringify(body(extra), null, 2) + '\n');

  function finish(extra = {}) {
    flush(extra);

    const counts = {};
    for (const o of rec.observations) counts[o.outcome] = (counts[o.outcome] || 0) + 1;
    const open = rec.settingsChanged.filter((s) => s.state !== 'restored');
    const stray = rec.fixtures.filter((f) => f.state === 'present' || f.state === 'removal-failed');
    const wentWrong = (counts.fail || 0) > 0;

    console.error('');
    console.error(`${suite} ${label}, ${profile} at ${viewport}:`);
    for (const [k, v] of Object.entries(counts)) console.error(`  ${v} ${k}`);
    if (open.length) console.error(`  ${open.length} shop setting(s) NOT put back`);
    if (stray.length) console.error(`  ${stray.length} made-up record(s) neither removed nor deliberately left`);
    const left = rec.fixtures.filter((f) => f.state === 'left');
    if (left.length) console.error(`  ${left.length} made-up record(s) left in the shop on purpose`);
    if (rec.harness.length) console.error(`  ${rec.harness.length} fault(s) in the run itself`);
    console.error(`written to ${file}`);

    // The exit code is about the run, never about the theme. Points failing is
    // the run working, so it exits 0. Only a run that cannot be trusted, or one
    // that left the shop altered, exits 2.
    process.exitCode = rec.harness.length || open.length || stray.length ? 2 : 0;
    return { wentWrong, counts, open, stray };
  }

  function die(e) {
    fault(`the run stopped: ${String((e && e.stack) || e)}`);
    flush({ outcome: 'the run did not finish' });
    process.exit(2);
  }

  return { rec, state, observe, step, note, fault, settingOpened, settingRestored,
           fixtureCreated, fixtureRemoved, fixtureLeft, finish, die, flush };
}

module.exports = { OUTCOMES, startSuite, sha256, sha256File, slug, arg };
