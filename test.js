'use strict';

// Minimal dependency-free test harness driving the built CLI as a subprocess.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'cli.js');
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

check('default mode prints a matching line once, like grep (minified)', () => {
  // Two matches share the single physical line; grep prints the line once.
  const { stdout, status } = run(['.hit'], { input: minified });
  assert.strictEqual(status, 0);
  assert.strictEqual(stdout.trimEnd(), minified);
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
  assert.deepStrictEqual(Object.keys(recs[0]).sort(),
    ['attribs', 'col', 'file', 'html', 'line', 'text']);
  assert.deepStrictEqual(recs[0].attribs, { class: 'a' });
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
  // climbing far past the root just yields the top element, no crash. The
  // <section> (top element) has no class attribute, so nothing prints — and
  // since nothing was emitted, the exit status is 1.
  const { stdout, status } = run(['p.x', '--parent', '99', '--attr', 'class'], { input: nested, expectStatus: 1 });
  assert.strictEqual(status, 1);
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

// --follow fixtures need symlink support (unavailable on Windows CI without
// developer mode); skip these checks rather than fail there.
const symRoot = path.join(tmp, 'symtest');
let symlinksOk = true;
try {
  fs.mkdirSync(path.join(symRoot, 'real'), { recursive: true });
  fs.writeFileSync(path.join(symRoot, 'real', 'a.html'), '<p class="s">x</p>');
  fs.symlinkSync(path.join('real', 'a.html'), path.join(symRoot, 'link.html'), 'file');
  fs.symlinkSync('real', path.join(symRoot, 'linkdir'), 'dir');
  fs.symlinkSync('..', path.join(symRoot, 'real', 'loop'), 'dir');   // cycle
} catch (e) {
  symlinksOk = false;
}

if (symlinksOk) {
  check('-r skips symlinks by default', () => {
    const { stdout } = run(['p.s', '-r', '-l', symRoot]);
    assert.deepStrictEqual(stdout.trimEnd().split('\n'), [path.join(symRoot, 'real', 'a.html')]);
  });

  check('-rS follows symlinks, visits each physical dir once, survives cycles', () => {
    const { stdout, status } = run(['p.s', '-rS', '-l', symRoot]);
    assert.strictEqual(status, 0);
    const files = stdout.trimEnd().split('\n');
    // link.html plus exactly one path into the physical `real` dir (whichever
    // of real/ or linkdir/ the walk reached first); the `loop` symlink back to
    // the root must not recurse forever or duplicate anything.
    assert.strictEqual(files.length, 2);
    assert.ok(files.includes(path.join(symRoot, 'link.html')));
  });
}

check('-c prints zero counts per file, grep-style', () => {
  // fMin has no div.a; it must still report min.html:0 (exit 0: fMulti matched).
  const { stdout, status } = run(['div.a', '-c', fMulti, fMin]);
  assert.strictEqual(status, 0);
  const lines = stdout.trimEnd().split('\n').sort();
  assert.deepStrictEqual(lines, [`${fMin}:0`, `${fMulti}:2`]);
});

check('-c single input with no match prints a lone 0 and exits 1', () => {
  const { stdout, status } = run(['.nope', '-c'], { input: multiline, expectStatus: 1 });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout.trimEnd(), '0');
});

check('bare --color means auto: no escapes when stdout is a pipe', () => {
  // grep parity — a bare --color used to force color on.
  const { stdout, status } = run(['div.a', '--color'], { input: multiline });
  assert.strictEqual(status, 0);
  assert.ok(!stdout.includes('\x1b['), 'expected no ANSI escapes through a pipe');
});

check('--attr matches attribute names case-insensitively', () => {
  // htmlparser2 lowercases attribute names; --attr HREF used to never match.
  const { stdout, status } = run(['a', '--attr', 'HREF'], { input: '<a HREF="x.html">l</a>' });
  assert.strictEqual(status, 0);
  assert.strictEqual(stdout.trimEnd(), 'x.html');
});

check('--attr with every match skipped: no output, exit 1', () => {
  // Regression: selector matches counted as "found" even when nothing printed.
  const { stdout, status } = run(['a', '--attr', 'href'], { input: '<a>no href</a>', expectStatus: 1 });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout, '');
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

check('-w never slices an astral char in half', () => {
  // Cutting <i>😀😀</i> at width 5 would land between the surrogate halves of
  // the first emoji; a lone half serializes as U+FFFD.
  const { stdout } = run(['i', '-w', '5'], { input: '<i>😀😀</i>' });
  assert.ok(!stdout.includes('�'), 'output contains a broken surrogate');
  assert.strictEqual(stdout.trimEnd(), '<i>…');
});

check('binary stdin is skipped, exit 1', () => {
  const { stdout, status } = run(['div'], {
    input: '<div>x</div>\x00\x01\x02\x03', expectStatus: 1,
  });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout, '');
});

check('-r walks in sorted order for deterministic output', () => {
  // multi.html sorts before sub/nested.html; readdir order must not leak through.
  const { stdout } = run(['div.a', '-r', '-l', tmp]);
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), [fMulti, fNested]);
});

// --- inversion recipes --------------------------------------------------------
// There is deliberately no -v flag; the README/man document :not()/:has()
// recipes instead (see ROADMAP Phase 7). These pin the recipes to shipped
// css-select behavior so the docs can't silently rot.
const invHtml = [
  '<body>',
  '<nav><a href="/home">home</a></nav>',
  '<div class="card"><a href="/x">buy</a></div>',
  '<div class="card"><span>no link</span></div>',
  '<img src="a.png" alt="ok"><img src="b.png">',
  '<footer><a href="/legal">legal</a></footer>',
  '</body>',
].join('\n');

check('recipe: img:not([alt]) finds images missing alt', () => {
  const { stdout } = run(['img:not([alt])', '--attr', 'src'], { input: invHtml });
  assert.strictEqual(stdout.trimEnd(), 'b.png');
});

check('recipe: :not(:has(...)) finds containers lacking a descendant', () => {
  const { stdout } = run(['div.card:not(:has(a))', '--text'], { input: invHtml });
  assert.strictEqual(stdout.trimEnd(), 'no link');
});

check('recipe: :not() takes a selector list with complex selectors', () => {
  const { stdout } = run(['a:not(nav a, footer a)', '--text'], { input: invHtml });
  assert.strictEqual(stdout.trimEnd(), 'buy');
});

check('-v / --invert-match fail with a pointer to the :not()/:has() recipes', () => {
  for (const flag of ['-v', '--invert-match']) {
    const r = spawnSync('node', [CLI, 'div', flag], { input: '<div>x</div>', encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes('no invert-match'), `${flag}: expected the teaching message`);
    assert.ok(r.stderr.includes(':not('), `${flag}: expected a recipe pointer`);
  }
});

// --- multiple selectors (-e) --------------------------------------------------
const multiSel = '<html><body><h1>Widget</h1><div class="card">'
  + '<span class="price">$4.99</span><a href="/buy">buy</a></div></body></html>';

check('-e: matches merge in document order, tagged [label]', () => {
  const { stdout } = run(['-n', '-e', 'title=h1', '-e', 'price=.card .price'], { input: multiSel });
  const lines = stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].startsWith('1:13 [title] '), lines[0]);
  assert.ok(lines[1].startsWith('1:46 [price] '), lines[1]);
});

check('-e: an unlabeled selector is tagged with its own text', () => {
  const { stdout } = run(['--text', '-e', 'h1'], { input: multiSel });
  assert.strictEqual(stdout.trimEnd(), '[h1] Widget');
});

check('-e: a leading attribute selector is not mistaken for a label', () => {
  const { stdout } = run(['--text', '-e', '[href]'], { input: multiSel });
  assert.strictEqual(stdout.trimEnd(), '[[href]] buy');
});

check('--json: records carry the attribs object (empty when none)', () => {
  const rec = JSON.parse(run(['a', '--json'],
    { input: '<a href="/x" CLASS="ext">go</a>' }).stdout.trim());
  assert.deepStrictEqual(rec.attribs, { href: '/x', class: 'ext' }); // names lowercased
  const bare = JSON.parse(run(['b', '--json'], { input: '<b>x</b>' }).stdout.trim());
  assert.deepStrictEqual(bare.attribs, {});
});

check('-e: --json records carry the label; without -e they do not', () => {
  const labeled = JSON.parse(run(['--json', '-e', 'price=.price'], { input: multiSel }).stdout.trim());
  assert.strictEqual(labeled.label, 'price');
  assert.strictEqual(labeled.text, '$4.99');
  const plain = JSON.parse(run(['--json', '.price'], { input: multiSel }).stdout.trim());
  assert.ok(!('label' in plain));
});

check('-e: -m caps the merged document-order stream, not each selector', () => {
  const { stdout } = run(
    ['--text', '-m', '2', '-e', 'title=h1', '-e', 'price=.price', '-e', 'link=a'],
    { input: multiSel });
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), ['[title] Widget', '[price] $4.99']);
});

check('-e: a node matching two selectors emits once per selector, in -e order', () => {
  const { stdout } = run(['--text', '-e', 'x=.price', '-e', 'y=span'], { input: multiSel });
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), ['[x] $4.99', '[y] $4.99']);
});

check('-e: --parent dedups per (ancestor, label)', () => {
  const { stdout } = run(['--text', '-e', 'p1=.price', '-e', 'p2=a', '--parent', '1'],
    { input: multiSel });
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), ['[p1] $4.99buy', '[p2] $4.99buy']);
});

check('-e: positionals are file paths, like grep -e', () => {
  const { stdout } = run(['-e', 'got=div.a', '--text', fMulti]);
  assert.deepStrictEqual(stdout.trimEnd().split('\n'), ['[got] one', '[got] three']);
});

// --- library API (lib.js) ----------------------------------------------------
// The lib is consumed in-process: require('cssgrep') must expose parse()
// without executing the CLI (which is what the old index.js did on require).
const { parse } = require('./lib.js');

check('lib: parse once, matches carry positions', () => {
  const matches = parse(multiline).search('div.a');
  assert.strictEqual(matches.length, 2);
  const m = matches[0];
  assert.strictEqual(m.line, 4);
  assert.strictEqual(m.col, 5);
  assert.strictEqual(m.tag, 'div');
  assert.deepStrictEqual(m.attribs, { class: 'a' });
  assert.strictEqual(m.html, '<div class="a">one</div>');
  assert.strictEqual(m.text, 'one');
  assert.strictEqual(multiline.slice(m.start, m.end), m.html);
});

check('lib: one document handle serves many searches', () => {
  const doc = parse(multiline);
  assert.strictEqual(doc.search('div.a').length, 2);
  assert.strictEqual(doc.search('p#x')[0].text, 'two');
  assert.strictEqual(doc.search('.nope').length, 0);
  assert.strictEqual(doc.html, multiline);
});

check('lib: col counts bytes, like the CLI -n locator', () => {
  const m = parse('<p>é<b>x</b></p>').search('b')[0];
  assert.strictEqual(m.line, 1);
  assert.strictEqual(m.col, 6); // "<p>é" is 5 bytes in UTF-8, so <b> starts at byte col 6
});

check('lib: lazy match fields survive JSON.stringify; node stays out of it', () => {
  const m = JSON.parse(JSON.stringify(parse(minified).search('.hit')[0]));
  assert.strictEqual(m.html, '<span class="hit">a</span>');
  assert.strictEqual(m.text, 'a');
  assert.strictEqual(m.line, 1);
  assert.ok(!('node' in m), 'circular node reference must not serialize');
});

check('lib: node escape hatch exposes the raw htmlparser2 element', () => {
  const m = parse(minified).search('.hit')[0];
  assert.strictEqual(m.node.name, 'span');
  assert.strictEqual(m.node.startIndex, m.start);
});

check('lib: opts.parent retargets to the deduped ancestor', () => {
  const matches = parse(minified).search('.hit', { parent: 1 });
  assert.strictEqual(matches.length, 1); // both spans share the one div
  assert.strictEqual(matches[0].tag, 'div');
});

check('lib: throws on an invalid selector and on non-string input', () => {
  const doc = parse(minified);
  assert.throws(() => doc.search('div['));
  assert.throws(() => doc.search(''), TypeError);
  assert.throws(() => parse(null), TypeError);
});

// --- rewrite mode (lib transform + CLI) ----------------------------------------

check('transform: class ops splice only the matched tag', () => {
  const doc = parse('<i>é</i><div class="a" title=\'q\'>x</div>');
  const { html, edits } = doc.transform('div', { addClass: 'b' });
  assert.strictEqual(html, '<i>é</i><div class="a b" title=\'q\'>x</div>');
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(doc.html.slice(edits[0].start, edits[0].end), edits[0].before);
  assert.strictEqual(edits[0].after, '<div class="a b" title=\'q\'>');
});

check('transform: add-class dedups, remove-class drops an emptied attribute', () => {
  const doc = parse('<div class="a">x</div>');
  assert.strictEqual(doc.transform('div', { addClass: 'a' }).edits.length, 0);
  assert.strictEqual(doc.transform('div', { removeClass: 'a' }).html, '<div>x</div>');
});

check('transform: set-attr replaces, adds, and escapes; remove-attr takes duplicates', () => {
  const doc = parse('<a href=/old style="x" STYLE="y">go</a>');
  const r = doc.transform('a', { setAttr: { href: '/n', 'data-t': 'a"b&c' }, removeAttr: 'style' });
  assert.strictEqual(r.html, '<a href="/n" data-t="a&quot;b&amp;c">go</a>');
});

check('transform: quoted ">" in an attribute value does not end the tag', () => {
  const r = parse('<div title="a>b">x</div>').transform('div', { addClass: 'c' });
  assert.strictEqual(r.html, '<div title="a>b" class="c">x</div>');
});

check('transform: fixed pipeline order — remove-attr class then add-class', () => {
  const r = parse('<div class="a b">x</div>')
    .transform('div', { addClass: 'x', removeAttr: 'class' });
  assert.strictEqual(r.html, '<div class="x">x</div>');
});

check('transform: rename-tag edits both tags, nested matches stay disjoint', () => {
  const r = parse('<div><div>x</div></div>').transform('div', { renameTag: 'section' });
  assert.strictEqual(r.html, '<section><section>x</section></section>');
  assert.strictEqual(r.edits.length, 4);
});

check('transform: rename-tag never invents a closing tag (void/self-closing/implied)', () => {
  const r = parse('<img src=x><br/><ul><li>a<li>b</ul>')
    .transform('img, br, li', { renameTag: 'x' });
  assert.strictEqual(r.html, '<x src=x><x/><ul><x>a<x>b</ul>');
});

check('transform: throws on empty ops, unknown op, bad names', () => {
  const doc = parse('<b>x</b>');
  assert.throws(() => doc.transform('b', {}), TypeError);
  assert.throws(() => doc.transform('b', { addClas: 'x' }), TypeError);
  assert.throws(() => doc.transform('b', { renameTag: 'a b' }), TypeError);
  assert.throws(() => doc.transform('b', { addClass: 'a"b' }), TypeError);
});

const rwDoc = '<html>\n<body>\n<div class="card old">one</div>\n<p>keep</p>\n</body>\n</html>\n';

check('rewrite CLI: emits the edited document, other bytes untouched', () => {
  const { stdout, status } = run(['.old', '--remove-class', 'old', '--add-class', 'fresh'],
    { input: rwDoc });
  assert.strictEqual(status, 0);
  assert.strictEqual(stdout, rwDoc.replace('class="card old"', 'class="card fresh"'));
});

check('rewrite CLI: no match passes the document through with exit 1', () => {
  const { stdout, status } = run(['.nope', '--add-class', 'x'], { input: rwDoc, expectStatus: 1 });
  assert.strictEqual(status, 1);
  assert.strictEqual(stdout, rwDoc);
});

check('rewrite CLI: --diff emits a unified diff that git apply accepts', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rw-'));
  fs.writeFileSync(path.join(dir, 'p.html'), '<b class=x>no newline</b>'); // also: no EOL
  const diff = spawnSync('node', [CLI, 'b', '--add-class', 'y', '--diff', 'p.html'],
    { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0);
  assert.ok(diff.stdout.startsWith('--- a/p.html\n+++ b/p.html\n'), diff.stdout);
  assert.ok(diff.stdout.includes('\\ No newline at end of file'));
  const git = spawnSync('git', ['apply', '-'], { cwd: dir, input: diff.stdout, encoding: 'utf8' });
  if (git.error && git.error.code === 'ENOENT') return; // no git on this machine: skip
  assert.strictEqual(git.status, 0, git.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'p.html'), 'utf8'),
    '<b class="x y">no newline</b>');
});

check('rewrite CLI: multiple files require --diff; --diff covers them all', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rw-'));
  for (const n of ['m1.html', 'm2.html']) fs.writeFileSync(path.join(dir, n), '<b>x</b>\n');
  const bare = spawnSync('node', [CLI, 'b', '--add-class', 'z', 'm1.html', 'm2.html'],
    { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(bare.status, 2);
  const diff = spawnSync('node', [CLI, 'b', '--add-class', 'z', '--diff', 'm1.html', 'm2.html'],
    { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0);
  assert.strictEqual((diff.stdout.match(/^\+\+\+ /gm) || []).length, 2);
});

check('rewrite CLI: refuses non-UTF-8 input with exit 2', () => {
  const r = spawnSync('node', [CLI, 'b', '--add-class', 'x'],
    { input: Buffer.from([0x3c, 0x62, 0x3e, 0xff, 0x3c, 0x2f, 0x62, 0x3e]) });
  assert.strictEqual(r.status, 2);
  assert.ok(String(r.stderr).includes('not valid UTF-8'));
});

check('rewrite CLI: rejects print/aggregate/-e/-m combinations', () => {
  for (const extra of [['--json'], ['-c'], ['-n'], ['-m', '1'], ['-e', 'x=b']]) {
    const r = spawnSync('node', [CLI, 'b', '--add-class', 'x', ...extra],
      { input: '<b>x</b>', encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `${extra.join(' ')} should be rejected`);
  }
});

check('rewrite CLI: --parent retargets the edit to the container', () => {
  const { stdout } = run(['.price', '--add-class', 'sale', '--parent', '1'],
    { input: '<div class="card"><span class="price">4</span></div>' });
  assert.strictEqual(stdout, '<div class="card sale"><span class="price">4</span></div>');
});

// --- watch mode ----------------------------------------------------------------
// Watch runs forever, so these spawn an async Node driver that starts the
// watcher, mutates files on a timer, SIGINTs it, and reports what it saw.
// Timings are generous to absorb slow CI filesystems.
function driveWatch(dir, cliArgs, mutations) {
  const driver = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const c = spawn(process.execPath, ${JSON.stringify([CLI, ...cliArgs])},
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => out += d);
    c.stderr.on('data', d => err += d);
    ${mutations.map(([ms, file, content]) =>
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)}), ${ms});`
  ).join('\n')}
    setTimeout(() => c.kill('SIGINT'), 1600);
    c.on('exit', code => console.log(JSON.stringify({ code, out, err })));
  `;
  const r = spawnSync('node', ['-e', driver], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  return JSON.parse(r.stdout);
}

check('--watch: reruns on change, discovers new files, SIGINT exits 0', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'watch-'));
  fs.writeFileSync(path.join(dir, 'a.html'), '<div class="err">one</div>\n');
  const r = driveWatch(dir, ['.err', '--watch', '-rn', '.'], [
    [500, 'a.html', '<p>fixed</p>\n'],                    // match disappears
    [1000, 'fresh.html', '<b class="err">new</b>\n'],     // re-walk must find it
  ]);
  const runs = r.out.split(/^== .*==$/m).filter(s => s.trim() !== '');
  assert.ok(r.out.includes('<div class="err">one</div>'), 'initial run output');
  assert.ok(r.out.includes('fresh.html:1:1'), 'new file discovered and matched');
  assert.ok(/== \d\d:\d\d:\d\d watching ==/.test(r.out), 'append-mode separator (piped)');
  assert.ok(!r.out.includes('\x1b[2J'), 'no clear codes into a pipe');
  assert.ok(runs.length >= 2, 'at least initial + one rerun');
  if (process.platform !== 'win32') assert.strictEqual(r.code, 0, r.err); // SIGINT → 0
});

check('--watch --json: NDJSON run events precede match records', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'watch-'));
  fs.writeFileSync(path.join(dir, 'a.html'), '<div class="err">one</div>\n');
  const r = driveWatch(dir, ['.err', '--watch', '-r', '--json', '.'], [
    [500, 'a.html', '<div class="err">one</div><div class="err">two</div>\n'],
  ]);
  const events = r.out.trim().split('\n').map(l => JSON.parse(l));
  const runs = events.filter(e => e.event === 'run');
  assert.ok(runs.length >= 2, 'initial + rerun events');
  assert.strictEqual(runs[0].changed, null);
  assert.strictEqual(runs[0].matches, 1);
  assert.strictEqual(runs[runs.length - 1].matches, 2);
  assert.ok(events.some(e => e.text === 'two'), 'match records follow the events');
});

check('--watch validation: -q, rewrite ops, stdin, --no-clear misuse rejected', () => {
  const cases = [
    [['div', '--watch', '-q', fMulti]],
    [['div', '--watch', '--add-class', 'x', fMulti]],
    [['div', '--watch']],                                  // stdin: nothing to watch
    [['div', '--no-clear', fMulti]],                       // --no-clear needs --watch
    [['div', '--watch', '--no-clear', '--json', fMulti]],
  ];
  for (const [args] of cases) {
    const r = spawnSync('node', [CLI, ...args], { input: '', encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `${args.join(' ')} should exit 2: ${r.stderr}`);
  }
});

// --- embedded HTML in JS/TS (template literals) ---------------------------------
const embJs = [
  '// backtick ` in a comment is noise',
  "const s = 'not ` a template';",
  'const t = html`<div class="${cls} card"><a href="/x">go</a></div>`;',
  'const g = `hello ${name}`;',
  'const u = html`<b>${x.map(v => html`<i class="in">${v}</i>`)}</b>`;',
  'const open = html`<p>`;',
  'const closed = html`<em class="y">z</em>`;',
].join('\n') + '\n';
const fEmb = path.join(tmp, 'card.js');
fs.writeFileSync(fEmb, embJs);

check('embedded: matches inside template literals get host-file locators', () => {
  const { stdout, status } = run(['.card', '-n', fEmb]);
  assert.strictEqual(status, 0);
  // line 3; `const t = html\`` is 15 chars, so the < of <div> sits at col 16
  assert.ok(stdout.startsWith('3:16 '), stdout);
});

check('embedded: a ${hole} in an attribute still matches; output shows the original', () => {
  const { stdout } = run(['.card', fEmb]);
  assert.ok(stdout.includes('${cls} card'), 'interpolation text visible in the printed line');
});

check('embedded: nested template literals contribute their own fragments', () => {
  const { stdout } = run(['i.in', '-n', fEmb]);
  assert.ok(stdout.startsWith('5:37 '), stdout);
});

check('embedded: an unclosed tag in one literal never adopts the next literal', () => {
  const { status } = run(['p .y, p em', fEmb], { expectStatus: 1 });
  assert.strictEqual(status, 1);
  const { stdout } = run(['.y', '-n', fEmb]);
  assert.ok(stdout.startsWith('7:21 '), stdout);
});

check('embedded: non-markup literals, strings and comments contribute nothing', () => {
  // `hello ${name}` and the quoted/commented backticks must not become
  // fragments; only the four markup literals exist, so body counts them.
  const { stdout } = run(['div, a, b, i, p, em', '-c', fEmb]);
  assert.strictEqual(stdout.trimEnd(), '6');
});

check('embedded: --json carries the original source slice, holes visible', () => {
  const rec = JSON.parse(run(['.card a', '--json', fEmb]).stdout.trim());
  assert.strictEqual(rec.html, '<a href="/x">go</a>');
  assert.strictEqual(rec.line, 3);
  const card = JSON.parse(run(['.card', '--json', fEmb]).stdout.trim());
  assert.ok(card.html.includes('${cls}'), 'hole text preserved in html field');
});

check('embedded: -r --ext js discovers matches in a tree', () => {
  const dir = path.join(tmp, 'embtree');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const x = html`<div class="hit">1</div>`;\n');
  fs.writeFileSync(path.join(dir, 'b.html'), '<div class="hit">2</div>\n');
  const { stdout } = run(['.hit', '-r', '--ext', 'js,html', '-l', dir]);
  assert.strictEqual(stdout.trimEnd().split('\n').length, 2);
});

// --- teardown ---------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
