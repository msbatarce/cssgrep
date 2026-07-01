'use strict';

// Minimal dependency-free test harness driving the built CLI as a subprocess.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cssgrep-'));
let failures = 0;

function run(args, { input, expectStatus } = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: input == null ? undefined : input,
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (e) {
    if (expectStatus !== undefined && e.status === expectStatus) {
      return { status: e.status, stdout: e.stdout || '' };
    }
    if (expectStatus === undefined) throw e;
    return { status: e.status, stdout: e.stdout || '' };
  }
}

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// --- fixtures ---------------------------------------------------------------
const multiline = `<!doctype html>
<html>
  <body>
    <div class="a">one</div>
    <p id="x">two</p>
    <div class="a">three</div>
  </body>
</html>
`;
const minified = `<div><span class="hit">a</span><span class="hit">b</span></div>`;
const crlf = `<ul>\r\n<li>one</li>\r\n<li>two</li>\r\n</ul>\r\n`;

const fMulti = path.join(tmp, 'multi.html');
const fMin = path.join(tmp, 'min.html');
const fCrlf = path.join(tmp, 'crlf.html');
const sub = path.join(tmp, 'sub');
fs.mkdirSync(sub);
const fNested = path.join(sub, 'nested.html');
fs.writeFileSync(fMulti, multiline);
fs.writeFileSync(fMin, minified);
fs.writeFileSync(fCrlf, crlf);
fs.writeFileSync(fNested, multiline);

// --- tests ------------------------------------------------------------------
check('stdin: default prints just the matched line, no locator', () => {
  const { stdout, status } = run(['div.a'], { input: multiline });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(status, 0);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], '    <div class="a">one</div>');
  assert.strictEqual(lines[1], '    <div class="a">three</div>');
});

check('-n stdin: line:col format, no file prefix', () => {
  const { stdout, status } = run(['div.a', '-n'], { input: multiline });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(status, 0);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], '4:5     <div class="a">one</div>');
  assert.strictEqual(lines[1], '6:5     <div class="a">three</div>');
});

check('single file: default has no file prefix', () => {
  const { stdout } = run(['p#x', fMulti]);
  assert.strictEqual(stdout.trimEnd(), '    <p id="x">two</p>');
});

check('-n single file: no file prefix', () => {
  const { stdout } = run(['p#x', '-n', fMulti]);
  assert.strictEqual(stdout.trimEnd(), '5:5     <p id="x">two</p>');
});

check('-n minified single line: distinct columns on line 1', () => {
  const { stdout } = run(['.hit', '-n'], { input: minified });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].split(' ')[0], '1:6');
  assert.strictEqual(lines[1].split(' ')[0], '1:32');
});

check('-n CRLF: trailing \\r stripped from shown line', () => {
  const { stdout } = run(['li', '-n'], { input: crlf });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines[0], '2:1 <li>one</li>');
  assert.strictEqual(lines[1], '3:1 <li>two</li>');
});

check('multiple files: default shows file: prefix, no locator', () => {
  const { stdout } = run(['p#x', fMulti, fNested]);
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.every(l => l.startsWith(fMulti + ':') || l.startsWith(fNested + ':')), stdout);
  assert.ok(lines.includes(`${fMulti}:    <p id="x">two</p>`), stdout);
});

check('-n multiple files: file:line:col prefix appears', () => {
  const { stdout } = run(['p#x', '-n', fMulti, fNested]);
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.every(l => l.startsWith(fMulti + ':') || l.startsWith(fNested + ':')), stdout);
  assert.ok(lines.includes(`${fMulti}:5:5     <p id="x">two</p>`), stdout);
});

check('-n recursive: walks into subdirectories', () => {
  const { stdout } = run(['div.a', '-n', '-r', tmp]);
  assert.ok(stdout.includes(`${fNested}:4:5`), stdout);
  assert.ok(stdout.includes(`${fMulti}:4:5`), stdout);
});

check('recursive: arg order is interchangeable (-r dir selector)', () => {
  const a = run(['div.a', '-r', tmp]).stdout;
  const b = run(['-r', tmp, 'div.a']).stdout;     // dir before selector
  const c = run(['-r', 'div.a', tmp]).stdout;     // vim grepprg order
  assert.strictEqual(b, a, 'dir-first should equal selector-first');
  assert.strictEqual(c, a, 'vim order should equal selector-first');
});

check('recursive: no path defaults to current directory', () => {
  const stdout = execFileSync('node', [CLI, 'div.a', '-n', '-r'], { cwd: tmp, encoding: 'utf8' });
  // paths are relative to cwd (tmp); both files should be found
  assert.ok(/(^|\n)multi\.html:4:5/.test(stdout), stdout);
  assert.ok(/(^|\n)sub[\\/]nested\.html:4:5/.test(stdout), stdout);
});

check('--max-width truncates with ellipsis', () => {
  const { stdout } = run(['span.hit', '-w', '12'], { input: minified });
  const shown = stdout.split('\n')[0];
  assert.strictEqual(shown.length, 12);
  assert.ok(shown.endsWith('…'), shown);
});

check('-n with -w: locator excluded from the width budget', () => {
  const { stdout } = run(['span.hit', '-n', '-w', '12'], { input: minified });
  const first = stdout.split('\n')[0];
  const shown = first.slice(first.indexOf(' ') + 1);
  assert.strictEqual(shown.length, 12);
  assert.ok(shown.endsWith('…'), shown);
});

check('--count reports number of matches', () => {
  const { stdout } = run(['div.a', '-c'], { input: multiline });
  assert.strictEqual(stdout.trim(), '2');
});

check('--print: no line:col locator, lone text child stays inline', () => {
  const { stdout } = run(['p#x', '-p'], { input: multiline });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines[0], '<p id="x">two</p>');
  assert.ok(!/^\d+:\d+/.test(stdout), 'should not print a line:col locator');
});

check('--print: re-indents minified input', () => {
  const { stdout } = run(['div', '-p'], { input: '<div><h1>Hi</h1><p>Yo</p></div>' });
  assert.strictEqual(stdout.trimEnd(), [
    '<div>',
    '  <h1>Hi</h1>',
    '  <p>Yo</p>',
    '</div>',
  ].join('\n'));
});

check('--print: preserves attributes, minimizes boolean attrs, no void close tag', () => {
  // js-beautify keeps short inline content (<input> is inline) on one line.
  const { stdout } = run(['form', '-p'], { input: '<form action="/x"><input required></form>' });
  assert.strictEqual(stdout.trimEnd(), '<form action="/x"><input required></form>');
});

// ANSI helpers for the --color tests.
const ESC = '\x1b[';
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

check('--color=never: output identical to default, no escapes', () => {
  const plain = run(['div.a'], { input: multiline }).stdout;
  const { stdout } = run(['div.a', '--color=never'], { input: multiline });
  assert.ok(!stdout.includes(ESC), 'should contain no escape sequences');
  assert.strictEqual(stdout, plain);
});

check('--color=auto piped (non-TTY): no escapes', () => {
  const { stdout } = run(['div.a', '--color=auto'], { input: multiline });
  assert.ok(!stdout.includes(ESC), stdout);
});

check('--color=always: wraps the matched node in the match color', () => {
  const { stdout } = run(['p#x', '--color=always'], { input: multiline });
  assert.ok(stdout.includes('\x1b[1;31m<p id="x">two</p>\x1b[0m'), JSON.stringify(stdout));
  // strip-to-plain matches the uncolored default output
  assert.strictEqual(stripAnsi(stdout).trimEnd(), '    <p id="x">two</p>');
});

check('--color=always -n: colors filename, line:col and match', () => {
  const { stdout } = run(['p#x', '-n', '--color=always', fMulti, fNested]);
  const first = stdout.split('\n')[0];
  assert.ok(first.includes(`\x1b[35m${fMulti}\x1b[0m`), 'filename in file color');
  assert.ok(first.includes('\x1b[32m5\x1b[0m'), 'line number in line color');
  assert.ok(first.includes('\x1b[1;31m'), 'match color present');
  assert.strictEqual(stripAnsi(first), `${fMulti}:5:5     <p id="x">two</p>`);
});

check('--color=always -w: width preserved, ellipsis left uncolored', () => {
  const { stdout } = run(['span.hit', '--color=always', '-w', '12'], { input: minified });
  const first = stdout.split('\n')[0];
  assert.strictEqual(stripAnsi(first).length, 12);
  assert.ok(stripAnsi(first).endsWith('…'), first);
  // the ellipsis must sit outside the closing reset, not inside the colored span
  assert.ok(first.includes('\x1b[0m…') || first.endsWith('…'), JSON.stringify(first));
});

check('--color=always -p: pretty-print stays uncolored', () => {
  const { stdout } = run(['p#x', '-p', '--color=always'], { input: multiline });
  assert.ok(!stdout.includes(ESC), stdout);
});

check('invalid --color value: exit status 2', () => {
  const { status } = run(['div.a', '--color=purple'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('no match: exit status 1, no output', () => {
  const { stdout, status } = run(['.nope'], { input: multiline, expectStatus: 1 });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout, '');
});

check('missing selector: exit status 2', () => {
  const { status } = run([], { input: '', expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('-n with -c: exit status 2 (mutually exclusive)', () => {
  const { status } = run(['div.a', '-n', '-c'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('-n with -p: exit status 2 (mutually exclusive)', () => {
  const { status } = run(['div.a', '-n', '-p'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

// --- teardown ---------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
