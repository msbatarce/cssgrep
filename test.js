'use strict';

// Minimal dependency-free test harness driving the built CLI as a subprocess.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
const fHtm = path.join(tmp, 'page.htm');
fs.writeFileSync(fMulti, multiline);
fs.writeFileSync(fMin, minified);
fs.writeFileSync(fCrlf, crlf);
fs.writeFileSync(fNested, multiline);
fs.writeFileSync(fHtm, '<p>htm</p>');

// A "binary" file whose bytes would match div.a if parsed — it must be skipped.
const fBin = path.join(tmp, 'blob.html');
fs.writeFileSync(fBin, Buffer.from('<div class="a">x</div>\x00\x01\x02\x03binary', 'binary'));

// Isolated tree for --ignore tests (selector p.t doesn't occur in the fixtures
// above, so these files never affect the other recursive tests).
const igRoot = path.join(tmp, 'igtest');
fs.mkdirSync(igRoot);
fs.mkdirSync(path.join(igRoot, 'node_modules'));
const igKeep = path.join(igRoot, 'keep.html');
const igMin = path.join(igRoot, 'skip.min.html');
const igDep = path.join(igRoot, 'node_modules', 'dep.html');
fs.writeFileSync(igKeep, '<p class="t">keep</p>');
fs.writeFileSync(igMin, '<p class="t">min</p>');
fs.writeFileSync(igDep, '<p class="t">dep</p>');

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

// --- ignore patterns (-i / --ignore / --ignore-file) ------------------------
check('-i excludes a matching directory while recursing', () => {
  const { stdout } = run(['p.t', '-l', '-i', 'node_modules', '-r', igRoot]);
  assert.ok(!stdout.includes('node_modules'), stdout);
  assert.ok(stdout.includes(igKeep), stdout);
});

check('--ignore glob skips matching files (basename)', () => {
  const { stdout } = run(['p.t', '-l', '--ignore', '*.min.html', '-r', igRoot]);
  const lines = stdout.trimEnd().split('\n');
  assert.ok(!lines.includes(igMin), stdout);
  assert.ok(lines.includes(igKeep) && lines.includes(igDep), stdout);
});

check('multiple -i patterns accumulate', () => {
  const { stdout } = run(['p.t', '-l', '-i', 'node_modules', '-i', '*.min.html', '-r', igRoot]);
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), [igKeep]);
});

check('-i trailing slash matches directories only', () => {
  const { stdout } = run(['p.t', '-l', '-i', 'node_modules/', '-r', igRoot]);
  assert.ok(!stdout.includes(igDep), stdout);
  assert.ok(stdout.includes(igKeep), stdout);
});

check('-ri clusters; -i consumes the next arg', () => {
  const { stdout } = run(['p.t', '-l', '-ri', 'node_modules', igRoot]);
  assert.ok(!stdout.includes(igDep), stdout);
});

check('--ignore-file loads patterns from a file', () => {
  const igf = path.join(tmp, 'myignore');
  fs.writeFileSync(igf, '# a comment\nnode_modules\n\n*.min.html\n');
  const { stdout } = run(['p.t', '-l', '--ignore-file', igf, '-r', igRoot]);
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), [igKeep]);
});

check('--ignore-file with a missing path: exit status 2', () => {
  const { status } = run(['p.t', '--ignore-file', path.join(tmp, 'nope.ignore'), '-r', igRoot],
    { expectStatus: 2 });
  assert.strictEqual(status, 2);
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

check('-m caps matches per file', () => {
  const { stdout } = run(['div.a', '-m', '1'], { input: multiline });
  assert.strictEqual(stdout.trimEnd().split('\n').length, 1);
});

check('-m1 attached value form', () => {
  const { stdout } = run(['div.a', '-m1'], { input: multiline });
  assert.strictEqual(stdout.trimEnd().split('\n').length, 1);
});

check('-m caps the -c count too', () => {
  const { stdout } = run(['div.a', '-c', '-m', '1'], { input: multiline });
  assert.strictEqual(stdout.trim(), '1');     // 2 matches, capped to 1
});

check('invalid --max-count value: exit status 2', () => {
  const { status } = run(['div.a', '-m', '0'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('-M caps matches in total across files', () => {
  // fMulti and fNested each have 2 div.a matches (4 total); -M3 stops at 3.
  const { stdout } = run(['div.a', '-M', '3', '-n', fMulti, fNested]);
  assert.strictEqual(stdout.trimEnd().split('\n').length, 3);
});

check('-M3 attached form: second file is partially consumed', () => {
  const { stdout } = run(['div.a', '-M3', fMulti, fNested]);
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines.filter(l => l.startsWith(fMulti)).length, 2);
  assert.strictEqual(lines.filter(l => l.startsWith(fNested)).length, 1);
});

check('-M combines with -m (smaller cap wins per file)', () => {
  // -m1 caps each file to 1; -M3 allows 3 total → 2 files give 2 lines
  const { stdout } = run(['div.a', '-m1', '-M3', '-n', fMulti, fNested]);
  assert.strictEqual(stdout.trimEnd().split('\n').length, 2);
});

check('invalid --max-total value: exit status 2', () => {
  const { status } = run(['div.a', '-M', '0'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('-l lists only files that match', () => {
  const { stdout } = run(['div.a', '-l', '-r', tmp]);
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.includes(fMulti) && lines.includes(fNested), stdout);
  assert.ok(!lines.some(l => /min\.html|crlf\.html|page\.htm/.test(l)), stdout);
});

check('-l prints the file name even for a single file', () => {
  const { stdout, status } = run(['p#x', '-l', fMulti]);
  assert.strictEqual(stdout.trimEnd(), fMulti);
  assert.strictEqual(status, 0);
});

check('-l from stdin names (standard input)', () => {
  const { stdout } = run(['div.a', '-l'], { input: multiline });
  assert.strictEqual(stdout.trimEnd(), '(standard input)');
});

check('-L lists only files without a match', () => {
  const { stdout } = run(['div.a', '-L', '-r', tmp]);
  const lines = stdout.trimEnd().split('\n');
  assert.ok(!lines.includes(fMulti) && !lines.includes(fNested), stdout);
  assert.ok(lines.includes(fMin), stdout);
});

check('-L exit 0 when a non-matching file is printed', () => {
  const { stdout, status } = run(['div.a', '-L', fMin]);
  assert.strictEqual(stdout.trimEnd(), fMin);
  assert.strictEqual(status, 0);
});

check('-L exit 1 (no output) when every file matches', () => {
  const { stdout, status } = run(['div.a', '-L', fMulti], { expectStatus: 1 });
  assert.strictEqual(stdout, '');
  assert.strictEqual(status, 1);
});

check('-q: no output, exit 0 on match', () => {
  const { stdout, status } = run(['div.a', '-q'], { input: multiline });
  assert.strictEqual(stdout, '');
  assert.strictEqual(status, 0);
});

check('-q: exit 1 when no match', () => {
  const { stdout, status } = run(['.nope', '-q'], { input: multiline, expectStatus: 1 });
  assert.strictEqual(stdout, '');
  assert.strictEqual(status, 1);
});

check('two aggregate modes (-c -l): exit status 2', () => {
  const { status } = run(['div.a', '-c', '-l'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('clustered aggregates (-lq): exit status 2', () => {
  const { status } = run(['div.a', '-lq'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

// --- extraction (--attr / --text) -------------------------------------------
const links = '<a href="/one">1</a>\n<a>no href</a>\n<a href="/two">2</a>\n';

check('--attr prints attribute values, skipping nodes without it', () => {
  const { stdout } = run(['a', '--attr', 'href'], { input: links });
  assert.strictEqual(stdout.trimEnd(), ['/one', '/two'].join('\n'));
});

check('--attr=href inline value form', () => {
  const { stdout } = run(['a', '--attr=href'], { input: links });
  assert.strictEqual(stdout.trimEnd(), ['/one', '/two'].join('\n'));
});

check('--attr honors -n locator', () => {
  const { stdout } = run(['a', '--attr', 'href', '-n'], { input: links });
  assert.strictEqual(stdout.trimEnd().split('\n')[0], '1:1 /one');
});

check('--text prints collapsed text content', () => {
  const { stdout } = run(['p', '--text'], { input: '<p>  hello\n   world  </p>' });
  assert.strictEqual(stdout.trimEnd(), 'hello world');
});

check('--text on nested markup concatenates descendants', () => {
  const { stdout } = run(['p', '--text'], { input: '<p>a <b>bold</b> c</p>' });
  assert.strictEqual(stdout.trimEnd(), 'a bold c');
});

check('-p with --attr: exit status 2 (one print mode only)', () => {
  const { status } = run(['a', '-p', '--attr', 'href'], { input: links, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('--attr with --text: exit status 2', () => {
  const { status } = run(['a', '--attr', 'href', '--text'], { input: links, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

// --- --json ------------------------------------------------------------------
check('--json emits one parseable record per match with expected fields', () => {
  const { stdout } = run(['div.a', '--json'], { input: multiline });
  const recs = stdout.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(Object.keys(recs[0]).sort(), ['col', 'file', 'html', 'line', 'text']);
  assert.strictEqual(recs[0].file, '(standard input)');
  assert.strictEqual(recs[0].line, 4);
  assert.strictEqual(recs[0].col, 5);
  assert.strictEqual(recs[0].html, '<div class="a">one</div>');
  assert.strictEqual(recs[0].text, 'one');
});

check('--json file field carries the path with multiple files', () => {
  const { stdout } = run(['p#x', '--json', fMulti, fNested]);
  const files = stdout.trimEnd().split('\n').map(l => JSON.parse(l).file);
  assert.ok(files.includes(fMulti) && files.includes(fNested), stdout);
});

check('--json with -p: exit status 2', () => {
  const { status } = run(['div.a', '--json', '-p'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

// --- -0 / --null -------------------------------------------------------------
check('-l -0 NUL-terminates file names, no newlines', () => {
  const { stdout } = run(['div.a', '-l', '-0', '-r', tmp]);
  assert.ok(!stdout.includes('\n'), 'no newlines with -l -0');
  const names = stdout.split('\0').filter(Boolean);
  assert.ok(names.includes(fMulti) && names.includes(fNested), stdout);
});

check('-0 line output uses NUL after the file name, keeps newlines', () => {
  const { stdout } = run(['p#x', '-n', '-0', fMulti, fNested]);
  const first = stdout.split('\n')[0];
  assert.strictEqual(first, `${fMulti}\x005:5     <p id="x">two</p>`);
});

check('-0 count output uses NUL after the file name', () => {
  const { stdout } = run(['div.a', '-c', '-0', fMulti, fNested]);
  assert.ok(stdout.split('\n')[0].startsWith(`${fMulti}\x00`), JSON.stringify(stdout));
});

// --- --parent (structural context) ------------------------------------------
const nested = '<section><article><h2>Title</h2><p class="x">body</p></article></section>';

check('--parent 1 -p pretty-prints the immediate parent', () => {
  const { stdout } = run(['p.x', '-p', '--parent', '1'], { input: nested });
  assert.strictEqual(stdout.split('\n')[0], '<article>');
  assert.ok(stdout.includes('<p class="x">body</p>'), stdout);
});

check('--parent 2 climbs two levels', () => {
  const { stdout } = run(['p.x', '-p', '--parent', '2'], { input: nested });
  assert.strictEqual(stdout.split('\n')[0], '<section>');
});

check('--parent dedups a shared ancestor', () => {
  // two matches under one <article>; --parent 1 should print it once
  const html = '<article><p class="x">a</p><p class="x">b</p></article>';
  const { stdout } = run(['p.x', '--parent', '1', '--json'], { input: html });
  const recs = stdout.trimEnd().split('\n');
  assert.strictEqual(recs.length, 1, stdout);
  assert.strictEqual(JSON.parse(recs[0]).html, html);
});

check('--parent clamps at the document root', () => {
  // climbing far past the root just yields the top element, no crash
  const { stdout, status } = run(['p.x', '--parent', '99', '--attr', 'class'], { input: nested });
  assert.strictEqual(status, 0);
  // the <section> (top element) has no class attribute, so nothing prints
  assert.strictEqual(stdout, '');
});

check('--parent -p highlights the matched node inside the container', () => {
  const html = '<section><article><h2>T</h2><p class="x">body</p></article></section>';
  const { stdout } = run(['.x', '-p', '--parent', '1', '--color=always'], { input: html });
  assert.ok(stdout.includes('<article>'), stdout);                    // container printed
  assert.ok(stdout.includes('\x1b[1;31m'), 'match color present');
  assert.ok(stdout.includes('<p class="x">body</p>\x1b[0m'), stdout); // node wrapped + reset
  assert.ok(/<h2>T<\/h2>/.test(stdout), 'sibling preserved');         // layout intact
  assert.ok(!stdout.includes('<!--'), 'sentinels stripped');
});

check('--parent -p produces no blank line when source has surrounding whitespace', () => {
  // Pre-formatted input puts the matched node after a whitespace text node, so
  // beautify parks the marker on its own line; the code must fold, not blank.
  const html = '<div>\n  <h2>T</h2>\n  <p class="x">hit</p>\n  <span>z</span>\n</div>\n';
  const { stdout } = run(['.x', '-p', '--parent', '1', '--color=always'], { input: html });
  // no line consisting solely of indentation + an ANSI code
  const blank = stdout.split('\n').some(l => /^[ \t]*\x1b\[[0-9;]*m[ \t]*$/.test(l));
  assert.ok(!blank, JSON.stringify(stdout));
  assert.ok(stdout.includes('\x1b[1;31m<p class="x">hit</p>\x1b[0m'), stdout);
});

check('--parent -p without color emits no escapes (and no sentinels)', () => {
  const { stdout } = run(['.x', '-p', '--parent', '1', '--color=never'],
    { input: '<article><p class="x">b</p></article>' });
  assert.ok(!stdout.includes('\x1b['), stdout);
  assert.ok(!stdout.includes('\uE000') && !stdout.includes('<!--'), stdout);
});

check('--parent in line mode reports the ancestor position', () => {
  const multilineNested = '<section>\n  <article>\n    <p class="x">body</p>\n  </article>\n</section>\n';
  const { stdout } = run(['p.x', '-n', '--parent', '1'], { input: multilineNested });
  assert.strictEqual(stdout.split('\n')[0].split(' ')[0], '2:3');  // <article> at line 2 col 3
});

// --- context (-A / -B / -C) -------------------------------------------------
const ctxDoc =
  '<a>1</a>\n<b class="m">2</b>\n<c>3</c>\n<d>4</d>\n<e>5</e>\n<f class="m">6</f>\n<g>7</g>\n';

check('-C1 prints before/after with `--` between non-contiguous groups', () => {
  const { stdout } = run(['.m', '-C1', '-n'], { input: ctxDoc });
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), [
    '1-<a>1</a>',
    '2:1 <b class="m">2</b>',
    '3-<c>3</c>',
    '--',
    '5-<e>5</e>',
    '6:1 <f class="m">6</f>',
    '7-<g>7</g>',
  ]);
});

check('-A1 prints only following lines', () => {
  const { stdout } = run(['.m', '-A1', '-n'], { input: '<b class="m">1</b>\n<c>2</c>\n' });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines[0], '1:1 <b class="m">1</b>');
  assert.strictEqual(lines[1], '2-<c>2</c>');
});

check('-B1 prints only preceding lines', () => {
  const { stdout } = run(['.m', '-B1', '-n'], { input: '<a>0</a>\n<b class="m">1</b>\n' });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines[0], '1-<a>0</a>');
  assert.strictEqual(lines[1], '2:1 <b class="m">1</b>');
});

check('context windows merge for nearby matches (no separator)', () => {
  const adj = '<a>0</a>\n<b class="m">1</b>\n<c class="m">2</c>\n<d>3</d>\n';
  const { stdout } = run(['.m', '-C1'], { input: adj });
  assert.ok(!stdout.includes('--'), stdout);
  assert.strictEqual(stdout.trimEnd().split('\n').length, 4);  // lines 1-4, merged
});

check('-B clamps at the start of the file', () => {
  const { stdout } = run(['.m', '-B2', '-n'], { input: '<b class="m">x</b>\n<c>y</c>\n' });
  assert.strictEqual(stdout.trimEnd().split('\n')[0], '1:1 <b class="m">x</b>');
});

check('-C2 attached value form', () => {
  const { stdout } = run(['.m', '-C2', '-n'], { input: ctxDoc });
  assert.ok(stdout.includes('2:1 <b class="m">2</b>'), stdout);
});

check('context with an aggregate (-c): exit status 2', () => {
  const { status } = run(['.m', '-C1', '-c'], { input: ctxDoc, expectStatus: 2 });
  assert.strictEqual(status, 2);
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

// --- meta flags --------------------------------------------------------------
check('--version prints "cssgrep <version>" and exits 0', () => {
  const { status, stdout } = run(['--version']);
  assert.strictEqual(status, 0);
  assert.ok(/^cssgrep \d+\.\d+\.\d+\n$/.test(stdout), JSON.stringify(stdout));
});

check('-V short flag matches --version', () => {
  assert.strictEqual(run(['-V']).stdout, run(['--version']).stdout);
});

// --- filename control (-H / --no-filename) ----------------------------------
check('-H forces the file: prefix on a single file', () => {
  const { stdout } = run(['div.a', '-H', fMulti]);
  for (const line of stdout.split('\n').filter(Boolean)) {
    assert.ok(line.startsWith(fMulti + ':'), line);
  }
});

check('-H labels stdin as (standard input)', () => {
  const { stdout } = run(['div.a', '-H'], { input: multiline });
  assert.ok(stdout.split('\n')[0].startsWith('(standard input):'), stdout);
});

check('--no-filename suppresses the prefix across multiple files', () => {
  const { stdout } = run(['div.a', '--no-filename', fMulti, fNested]);
  assert.ok(!/multi\.html:|nested\.html:/.test(stdout), stdout);
});

check('-H with --no-filename: exit status 2', () => {
  const { status } = run(['div.a', '-H', '--no-filename'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

// --- -s / --no-messages ------------------------------------------------------
check('-s suppresses the error for a missing file', () => {
  const missing = path.join(tmp, 'does-not-exist.html');
  const without = spawnSync('node', [CLI, 'div.a', missing], { encoding: 'utf8' });
  assert.ok(without.stderr.length > 0, 'expected an error without -s');
  const withS = spawnSync('node', [CLI, 'div.a', '-s', missing], { encoding: 'utf8' });
  assert.strictEqual(withS.stderr, '', withS.stderr);
});

// --- binary file skipping ----------------------------------------------------
check('binary files are skipped (no match) with a note, suppressed by -s', () => {
  const r = spawnSync('node', [CLI, 'div.a', fBin], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, '', `expected no match output, got ${JSON.stringify(r.stdout)}`);
  assert.strictEqual(r.status, 1, 'a skipped binary file means no match (exit 1)');
  assert.ok(/binary file \(skipped\)/.test(r.stderr), r.stderr);
  const s = spawnSync('node', [CLI, 'div.a', '-s', fBin], { encoding: 'utf8' });
  assert.strictEqual(s.stderr, '', s.stderr);
});

// --- --include / --exclude ---------------------------------------------------
check('--include with a single glob restricts to matching files', () => {
  // page.htm is the only file matching *.htm exactly (not *.html)
  const out = execFileSync('node', [CLI, 'p', '-r', '--include', '*.htm'], { cwd: tmp, encoding: 'utf8' });
  assert.ok(/htm/.test(out), out);
  assert.ok(!/multi\.html|nested\.html/.test(out), out);
});

check('--include brace alternation matches both extensions', () => {
  const out = execFileSync('node', [CLI, 'p', '-r', '--include', '*.{html,htm}'], { cwd: tmp, encoding: 'utf8' });
  assert.ok(/page\.htm:/.test(out), `expected .htm hit\n${out}`);
  assert.ok(/multi\.html:|nested\.html:/.test(out), `expected .html hit\n${out}`);
});

check('--ext with --include: exit status 2', () => {
  const { status } = run(['p', '-r', '--ext', 'html', '--include', '*.htm'], { expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('--exclude is an alias of --ignore', () => {
  const a = execFileSync('node', [CLI, 'p.t', '-r', '--ignore', 'node_modules'], { cwd: igRoot, encoding: 'utf8' });
  const b = execFileSync('node', [CLI, 'p.t', '-r', '--exclude', 'node_modules'], { cwd: igRoot, encoding: 'utf8' });
  assert.strictEqual(b, a);
});

// --- --max-depth -------------------------------------------------------------
check('--max-depth 1 stays at the top level (no subdirectories)', () => {
  const out = execFileSync('node', [CLI, 'p#x', '-rn', '--max-depth', '1'], { cwd: tmp, encoding: 'utf8' });
  assert.ok(/multi\.html/.test(out), out);
  assert.ok(!/nested\.html/.test(out), `sub/ should not be searched\n${out}`);
});

check('--max-depth 2 descends one level into sub/', () => {
  const out = execFileSync('node', [CLI, 'p#x', '-rn', '--max-depth', '2'], { cwd: tmp, encoding: 'utf8' });
  assert.ok(/nested\.html/.test(out), out);
});

// --- option parsing ergonomics ----------------------------------------------
check('-w100 attached short value equals -w 100', () => {
  const a = run(['span.hit', '-w', '12'], { input: minified }).stdout;
  const b = run(['span.hit', '-w12'], { input: minified }).stdout;
  assert.ok(a.includes('…'), a);
  assert.strictEqual(b, a);
});

check('--max-width=12 long =value form', () => {
  const { stdout } = run(['span.hit', '--max-width=12'], { input: minified });
  assert.strictEqual(stdout.split('\n')[0].length, 12);
});

check('-rn clusters -r and -n', () => {
  const stdout = execFileSync('node', [CLI, 'div.a', '-rn'], { cwd: tmp, encoding: 'utf8' });
  assert.ok(/(^|\n)multi\.html:4:5 /.test(stdout), stdout);
});

check('-rnw15 clusters flags with a trailing attached value', () => {
  const stdout = execFileSync('node', [CLI, 'div.a', '-rnw15'], { cwd: tmp, encoding: 'utf8' });
  const line = stdout.split('\n').find(l => /multi\.html/.test(l));
  assert.ok(/multi\.html:4:5 /.test(line), line);           // -n locator present
  const shown = line.slice(line.indexOf(' ') + 1);
  assert.strictEqual(shown.length, 15);                     // -w15 truncation applied
});

check('-rnw 15 takes the value from the next argument', () => {
  const stdout = execFileSync('node', [CLI, 'div.a', '-rnw', '15'], { cwd: tmp, encoding: 'utf8' });
  const line = stdout.split('\n').find(l => /multi\.html/.test(l));
  assert.strictEqual(line.slice(line.indexOf(' ') + 1).length, 15);
});

check('--ext=htm (long =value) selects .htm under -r', () => {
  // page.htm is the only .htm match, so it prints as a single file (no prefix).
  const stdout = execFileSync('node', [CLI, 'p', '-rn', '--ext=htm'], { cwd: tmp, encoding: 'utf8' });
  assert.strictEqual(stdout.trimEnd(), '1:1 <p>htm</p>');
  assert.ok(!/multi\.html/.test(stdout), 'html files excluded by --ext=htm');
});

check('-nc cluster still trips -n/-c exclusivity: exit 2', () => {
  const { status } = run(['div.a', '-nc'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('-w without a value: exit status 2', () => {
  const { status } = run(['div.a', '-rw'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('unknown clustered short flag: exit status 2', () => {
  const { status } = run(['div.a', '-rx'], { input: multiline, expectStatus: 2 });
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

check('trailing --ignore without a value: clean exit 2, no stack trace', () => {
  // Regression: used to crash with a TypeError (exit 1) in compileIgnore.
  const { status } = run(['div.a', '--ignore'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('trailing -i without a value: clean exit 2', () => {
  const { status } = run(['div.a', '-i'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('trailing --attr without a value: exit 2, not silently ignored', () => {
  // Regression: opts.attr became undefined, which the != null check read as
  // "no --attr given", silently switching output modes.
  const { status } = run(['div.a', '--attr'], { input: multiline, expectStatus: 2 });
  assert.strictEqual(status, 2);
});

check('**/ glob stops at segment boundaries', () => {
  // Regression: **/foo.html compiled to .*foo\.html and matched barfoo.html.
  const gRoot = path.join(tmp, 'globtest');
  fs.mkdirSync(path.join(gRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(gRoot, 'foo.html'), '<p class="g">a</p>');
  fs.writeFileSync(path.join(gRoot, 'barfoo.html'), '<p class="g">b</p>');
  fs.writeFileSync(path.join(gRoot, 'sub', 'foo.html'), '<p class="g">c</p>');
  const { stdout } = run(['p.g', '-r', '--include', '**/foo.html', '-l', gRoot]);
  const files = stdout.trimEnd().split('\n').sort();
  assert.deepStrictEqual(files, [path.join(gRoot, 'foo.html'), path.join(gRoot, 'sub', 'foo.html')]);
});

check('-n columns count bytes, not code units (vim %c)', () => {
  // 'ééé' is 3 chars / 6 UTF-8 bytes: <span starts at byte 9 → col 10.
  const { stdout } = run(['#t', '-n'], { input: '<p>ééé<span id=t>x</span></p>' });
  assert.strictEqual(stdout.trimEnd().split(' ')[0], '1:10');
});

check('-n columns: astral chars count their UTF-8 bytes', () => {
  // '😀' is 4 UTF-8 bytes (2 code units): <span starts at byte 7 → col 8.
  const { stdout } = run(['#t', '-n'], { input: '<p>😀<span id=t>x</span></p>' });
  assert.strictEqual(stdout.trimEnd().split(' ')[0], '1:8');
});

check('--json col counts bytes too', () => {
  const { stdout } = run(['#t', '--json'], { input: '<p>ééé<span id=t>x</span></p>' });
  assert.strictEqual(JSON.parse(stdout).col, 10);
});

check('highlight still lands on the match after non-ASCII text', () => {
  const { stdout } = run(['#t', '--color=always'], { input: '<p>ééé<span id=t>x</span></p>' });
  assert.ok(stdout.includes('\x1b[1;31m<span id=t>x</span>\x1b[0m'));
});

check('large result set is not truncated through a pipe', () => {
  // Regression: process.exit() right after a big async pipe write used to drop
  // most of the output (~2.4k of 20k lines). 20k lines ≈ 500 KB, well past the
  // 64 KB pipe buffer.
  const fBig = path.join(tmp, 'big.html');
  fs.writeFileSync(fBig, '<html><body>\n' + '<p class="many">hello</p>\n'.repeat(20000) + '</body></html>\n');
  const { stdout, status } = run(['p.many', fBig]);
  assert.strictEqual(status, 0);
  assert.strictEqual(stdout.trimEnd().split('\n').length, 20000);
});

// --- teardown ---------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
