#!/usr/bin/env node
'use strict';

// Benchmark harness (ROADMAP Phase 11). Generates deterministic fixtures on
// first run (bench/fixtures/, gitignored), then times the CLI end-to-end as a
// subprocess — the number a user actually experiences, startup included.
// Wall times are medians over several runs (plus the min, the less-noisy
// signal); peak RSS is the child's own resourceUsage, sampled once.
//
// Run with `npm run bench`. Results are environment-dependent: benches are
// run manually and compared on the same machine, never gated in CI (decided
// 2026-07-07 — CI runner timing is far too noisy to gate on).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
const FIX = path.join(__dirname, 'fixtures');

// --- fixtures -----------------------------------------------------------------

function generateFixtures() {
  if (fs.existsSync(path.join(FIX, '.done'))) return;
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });

  // 1) One huge minified single-line document (~8 MB, 40k cards).
  const cards = [];
  for (let i = 0; i < 40000; i++) {
    cards.push(`<div class="card"><h2 class="title">Widget ${i}</h2>`
      + `<span class="price">$${i}.99</span><a href="/buy?id=${i}">buy</a></div>`);
  }
  fs.writeFileSync(path.join(FIX, 'huge-minified.html'),
    '<html><body>' + cards.join('') + '</body></html>');

  // 2) A tree of 1000 small files (20 dirs x 50); every 10th contains a hit.
  for (let d = 0; d < 20; d++) {
    const dir = path.join(FIX, 'tree', `d${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++) {
      const hit = (d * 50 + f) % 10 === 0 ? '<p class="hit">x</p>' : '';
      fs.writeFileSync(path.join(dir, `f${f}.html`),
        `<html>\n<body>\n${hit}<div class="filler">${'lorem ipsum '.repeat(40)}</div>\n</body>\n</html>\n`);
    }
  }

  // 3) Pathological nesting depth.
  const DEPTH = 2000;
  fs.writeFileSync(path.join(FIX, 'deep.html'),
    '<div>'.repeat(DEPTH) + '<b class="leaf">bottom</b>' + '</div>'.repeat(DEPTH));

  fs.writeFileSync(path.join(FIX, '.done'), '');
}

// --- measurement ----------------------------------------------------------------

function timeOnce(args) {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', 'ignore'], cwd: FIX });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Peak RSS: run the CLI in-process inside a wrapper child that prints its own
// resourceUsage on exit (spawnSync exposes no child rusage). Linux reports
// maxRSS in KB, macOS in bytes — normalize heuristically.
function peakRssMB(args) {
  const script = `
    process.argv = ['node', ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    process.on('exit', () => process.stderr.write('RSS:' + process.resourceUsage().maxRSS));
    require(${JSON.stringify(CLI)});
  `;
  const r = spawnSync(process.execPath, ['-e', script],
    { stdio: ['ignore', 'ignore', 'pipe'], cwd: FIX, encoding: 'utf8' });
  const m = /RSS:(\d+)/.exec(r.stderr || '');
  if (!m) return null;
  const raw = Number(m[1]);
  return (raw > 1e9 ? raw / 1e6 : raw) / 1024; // bytes vs KB -> MB
}

function bench(name, args, { runs = 7, rss = false } = {}) {
  const times = [];
  for (let i = 0; i < runs; i++) times.push(timeOnce(args));
  times.sort((a, b) => a - b);
  const med = times[(times.length - 1) >> 1];
  const rssMB = rss ? peakRssMB(args) : null;
  console.log(
    name.padEnd(44)
    + `${med.toFixed(1)} ms`.padStart(11)
    + `  (min ${times[0].toFixed(1)})`.padEnd(15)
    + (rssMB ? `  ${rssMB.toFixed(0)} MB peak` : ''),
  );
}

generateFixtures();
console.log(`cssgrep bench — node ${process.version}, ${os.type()} ${os.arch()}\n`);
bench('startup: --version', ['--version'], { runs: 15 });
bench('startup: no-match stdin-less run', ['.x', 'tree/d0/f1.html'], { runs: 15 });
bench('huge 8MB minified: .price (40k matches)', ['.price', 'huge-minified.html'], { rss: true });
bench('huge 8MB minified: -n -w60 (40k locators)', ['.price', '-n', '-w60', 'huge-minified.html'], { runs: 3 });
bench('huge 8MB minified: -q (existence only)', ['.price', '-q', 'huge-minified.html']);
bench('huge 8MB minified: -c (count only)', ['.price', '-c', 'huge-minified.html']);
bench('huge 8MB minified: zero matches', ['.nomatch', 'huge-minified.html']);
bench('tree 1000 files: -rn .hit (100 hits)', ['.hit', '-rn', 'tree'], { rss: true });
bench('tree 1000 files: -r -l', ['.hit', '-r', '-l', 'tree']);
bench('deep 2000-nest: .leaf --text', ['.leaf', '--text', 'deep.html']);
