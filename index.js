#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseDocument } = require('htmlparser2');
const { selectAll } = require('css-select');
const render = require('dom-serializer').default;
const { html: beautify } = require('js-beautify');

// Single source of truth for the version. A constant rather than a read of
// package.json, so it survives compilation into a standalone binary (Bun
// --compile / Node SEA), where package.json won't sit next to the executable.
// Keep in sync with package.json on release.
const VERSION = '1.1.0';

const USAGE = `cssgrep - search HTML by CSS selector, grep-style.

Usage:
  cssgrep <selector> [file ...]
  cssgrep <selector> -r <dir ...>
  cat file.html | cssgrep <selector>

Output (one line per match):
  {line contents}                           (default; stdin or single file)
  {file}:{line contents}                    (default; multiple files)
  {line}:{col} {line contents}              (with -n; stdin or single file)
  {file}:{line}:{col} {line contents}       (with -n; multiple files)

Options:
  -r, --recursive        Recurse into directory arguments.
      --max-depth <n>    Limit -r recursion depth (1 = the given dir only).
      --ext <list>       Comma-separated extensions for -r (default: html,htm).
      --include <glob>   Only search files matching <glob> (replaces --ext; repeatable).
  -i, --ignore <glob>    Skip files/dirs matching <glob> when recursing (repeatable).
      --exclude <glob>   Alias for --ignore.
      --ignore-file <path>   Read ignore globs from <path> (one per line, # comments).
  -n, --line-number      Prefix each match with its line:col (excludes -c, -p).
  -p, --print            Pretty-print the matched node's HTML above its location.
      --attr <name>      Print the value of attribute <name> (skips nodes without it).
      --text             Print the matched node's text content (whitespace collapsed).
      --json             Print one JSON record per match (NDJSON: file,line,col,html,text).
      --parent <n>       Report the n-th ancestor of each match instead (dedup'd).
  -w, --max-width <n>    Truncate the shown line to <n> columns (ellipsis added).
  -A, --after-context <n>    Print <n> source lines after each match.
  -B, --before-context <n>   Print <n> source lines before each match.
  -C, --context <n>          Print <n> source lines before and after each match.
  -m, --max-count <n>    Stop after <n> matches per file.
  -M, --max-total <n>    Stop after <n> matches in total (across all files).
  -c, --count            Print only a count of matches (per file when relevant).
  -l, --files-with-matches   Print only the names of files that have a match.
  -L, --files-without-match  Print only the names of files with no match.
  -q, --quiet            Print nothing; exit 0 on first match, 1 if none.
  -s, --no-messages      Suppress error messages for unreadable/missing files.
  -0, --null             Separate the file name with a NUL byte (for xargs -0).
  -H, --with-filename    Always print the file name prefix (even for one file).
      --no-filename      Never print the file name prefix (even for many files).
      --color[=<when>]   Colorize output: auto (default, also what a bare
                         --color means, like grep), always or never.
  -h, --help             Show this help.
  -V, --version          Show version and exit.

Short flags combine (-rn) and a value attaches to its flag (-w100) or follows it
(-w 100); a value-taking flag may close a cluster (-rnw100). Long options take a
value with = or as the next word (--max-width=100, --ext htm).

Globs (--include/--ignore/--exclude) support *, ** (crosses /), ?, and brace
alternation like *.{html,htm}.

Exit status: 0 if any match was found, 1 if none, 2 on error.`;

function fail(msg) {
  process.stderr.write(`cssgrep: ${msg}\n`);
  process.exit(2);
}

// ANSI SGR codes matching grep's default scheme: bold-red match, magenta
// filename, green line/col numbers, cyan separators.
const COLORS = {
  match: '1;31',
  file: '35',
  line: '32',
  sep: '36',
};

function paint(code, str) {
  return `\x1b[${code}m${str}\x1b[0m`;
}

function parseArgs(argv) {
  const opts = {
    selector: null,
    positionals: [],
    paths: [],
    recursive: false,
    exts: ['html', 'htm'],
    extGiven: false,
    maxDepth: 0,
    lineNumber: false,
    print: false,
    maxWidth: 0,
    maxCount: 0,
    maxTotal: 0,
    count: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    quiet: false,
    attr: null,
    text: false,
    json: false,
    nul: false,
    parent: 0,
    before: 0,
    after: 0,
    ignore: [],
    include: [],
    withFilename: false,
    noFilename: false,
    noMessages: false,
    color: 'auto',
  };
  const setExts = v => {
    opts.extGiven = true;
    opts.exts = (v || '').split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);
  };
  const boundedInt = (v, what, min) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < min) fail(`invalid ${what} value`);
    return n;
  };
  const positiveInt = (v, what) => boundedInt(v, what, 1);
  const setMaxWidth = v => { opts.maxWidth = positiveInt(v, '--max-width'); };
  const setMaxCount = v => { opts.maxCount = positiveInt(v, '--max-count'); };
  const setMaxTotal = v => { opts.maxTotal = positiveInt(v, '--max-total'); };
  const setMaxDepth = v => { opts.maxDepth = positiveInt(v, '--max-depth'); };
  const setParent = v => { opts.parent = positiveInt(v, '--parent'); };
  const setAfter = v => { opts.after = boundedInt(v, '--after-context', 0); };
  const setBefore = v => { opts.before = boundedInt(v, '--before-context', 0); };
  const setContext = v => { opts.after = opts.before = boundedInt(v, '--context', 0); };
  const addIgnore = v => { const c = compileIgnore(v); if (c) opts.ignore.push(c); };
  const addInclude = v => { const c = compileIgnore(v); if (c) opts.include.push(c); };
  const addIgnoreFile = v => {
    let content;
    try { content = fs.readFileSync(v, 'utf8'); }
    catch (e) { fail(`cannot read ignore file: ${v}`); }
    for (const line of content.split('\n')) { const c = compileIgnore(line); if (c) opts.ignore.push(c); }
  };
  // Short flags that take a value (rest of the cluster, or the next argument).
  const shortValueFlags = {
    w: setMaxWidth, m: setMaxCount, M: setMaxTotal, A: setAfter, B: setBefore, C: setContext,
    i: addIgnore,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Long options: --name or --name=value. A missing inline value is taken
    // from the next argument (except --color, where a bare flag means "auto",
    // as in GNU grep).
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      const value = () => {
        if (inline != null) return inline;
        if (i + 1 >= argv.length) fail(`option ${name} requires a value`);
        return argv[++i];
      };
      switch (name) {
        case '--help': process.stdout.write(USAGE + '\n'); process.exit(0); break;
        case '--version': process.stdout.write(`cssgrep ${VERSION}\n`); process.exit(0); break;
        case '--recursive': opts.recursive = true; break;
        case '--line-number': opts.lineNumber = true; break;
        case '--print': opts.print = true; break;
        case '--count': opts.count = true; break;
        case '--files-with-matches': opts.filesWithMatches = true; break;
        case '--files-without-match': opts.filesWithoutMatch = true; break;
        case '--quiet': case '--silent': opts.quiet = true; break;
        case '--null': opts.nul = true; break;
        case '--with-filename': opts.withFilename = true; break;
        case '--no-filename': opts.noFilename = true; break;
        case '--no-messages': opts.noMessages = true; break;
        case '--ext': setExts(value()); break;
        case '--ignore': case '--exclude': addIgnore(value()); break;
        case '--ignore-file': addIgnoreFile(value()); break;
        case '--include': addInclude(value()); break;
        case '--max-width': setMaxWidth(value()); break;
        case '--max-count': setMaxCount(value()); break;
        case '--max-total': setMaxTotal(value()); break;
        case '--max-depth': setMaxDepth(value()); break;
        // htmlparser2 lowercases HTML attribute names, so match case-insensitively.
        case '--attr': opts.attr = value().toLowerCase(); break;
        case '--text': opts.text = true; break;
        case '--json': opts.json = true; break;
        case '--parent': setParent(value()); break;
        case '--after-context': setAfter(value()); break;
        case '--before-context': setBefore(value()); break;
        case '--context': setContext(value()); break;
        case '--color': case '--colour': opts.color = inline != null ? inline : 'auto'; break;
        default: fail(`unknown option: ${name}`);
      }
      continue;
    }

    // Short options, getopt-style: flags cluster (`-rn`) and a value-taking
    // option consumes the rest of the cluster (`-w100`) or the next argument
    // (`-w 100`), which means it must come last in a cluster (`-rnw100`).
    if (a.startsWith('-') && a !== '-') {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (shortValueFlags[ch]) {
          const rest = a.slice(j + 1);          // attached value, if any
          if (rest === '' && i + 1 >= argv.length) fail(`option -${ch} requires a value`);
          shortValueFlags[ch](rest !== '' ? rest : argv[++i]);
          break;                                // value swallowed the cluster tail
        }
        switch (ch) {
          case 'h': process.stdout.write(USAGE + '\n'); process.exit(0); break;
          case 'V': process.stdout.write(`cssgrep ${VERSION}\n`); process.exit(0); break;
          case 'r': opts.recursive = true; break;
          case 'n': opts.lineNumber = true; break;
          case 'p': opts.print = true; break;
          case 'c': opts.count = true; break;
          case 'l': opts.filesWithMatches = true; break;
          case 'L': opts.filesWithoutMatch = true; break;
          case 'q': opts.quiet = true; break;
          case '0': case 'Z': opts.nul = true; break;
          case 'H': opts.withFilename = true; break;
          case 's': opts.noMessages = true; break;
          default: fail(`unknown option: -${ch}`);
        }
      }
      continue;
    }

    opts.positionals.push(a);
  }
  if (opts.positionals.length === 0) fail('no selector given (try --help)');
  // Aggregate modes each suppress per-match output, so at most one may apply.
  const aggregates = [opts.count, opts.filesWithMatches, opts.filesWithoutMatch, opts.quiet]
    .filter(Boolean).length;
  if (aggregates > 1) fail('only one of -c, -l, -L, -q may be given');
  // Filename prefix can be forced on or off, but not both (grep -H / -h).
  if (opts.withFilename && opts.noFilename) fail('-H cannot be combined with --no-filename');
  // --include fully replaces the extension filter, so the two can't coexist.
  if (opts.extGiven && opts.include.length) fail('--ext and --include cannot be combined');
  // Per-match print modes choose what is printed for each match; only one.
  const printModes = [opts.print, opts.attr != null, opts.text, opts.json].filter(Boolean).length;
  if (printModes > 1) fail('only one of -p, --attr, --text, --json may be given');
  // Context surrounds source lines, so it only makes sense for the default line
  // output — not the print modes or the content-suppressing aggregate modes.
  if (opts.before > 0 || opts.after > 0) {
    if (printModes > 0) fail('context (-A/-B/-C) cannot be combined with -p/--attr/--text/--json');
    if (aggregates > 0) fail('context (-A/-B/-C) cannot be combined with -c/-l/-L/-q');
  }
  if (opts.lineNumber && opts.count) fail('-n cannot be combined with -c');
  if (opts.lineNumber && opts.print) fail('-n cannot be combined with -p');
  if (!['auto', 'always', 'never'].includes(opts.color)) {
    fail(`invalid --color value: ${opts.color} (expected auto, always or never)`);
  }
  // Resolve the tri-state into a single boolean: color only when forced on, or
  // 'auto' and stdout is an interactive terminal. Plain -p still prints no
  // color (it has nothing to highlight) — that's gated where it prints, not
  // here, so --parent -p can highlight the matched node inside the container.
  opts.colorOn = opts.color === 'always' || (opts.color === 'auto' && Boolean(process.stdout.isTTY));
  return opts;
}

// The selector and the path list share the same positional slots, so their
// order on the command line is ambiguous (`<selector> <dir>` vs `<dir>
// <selector>`). Resolve it by what actually exists on disk: paths are the
// positionals that name a real file/dir, and the selector is the one that
// doesn't. This makes argument order not matter (important for vim's
// `grepprg`, which appends args in its own order). Fall back to
// "selector is the first positional" when the split is unclear.
function resolveSelectorAndPaths(opts) {
  const pos = opts.positionals;
  const onDisk = [];
  const notOnDisk = [];
  for (const p of pos) {
    if (fs.statSync(p, { throwIfNoEntry: false })) onDisk.push(p);
    else notOnDisk.push(p);
  }
  if (notOnDisk.length === 1) {
    opts.selector = notOnDisk[0];
    opts.paths = onDisk;
  } else {
    // 0 non-existent (selector also happens to name a file) or several
    // (a mistyped path, reported later): keep positional order.
    opts.selector = pos[0];
    opts.paths = pos.slice(1);
  }
}

// Precompute the byte offset at which each line starts, so offset->line/col
// is a binary search rather than a re-scan per match.
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function offsetToPosition(starts, src, offset) {
  // binary search for the greatest line start <= offset
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const lineStart = starts[lo];
  let lineEnd = src.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = src.length;
  // strip a trailing \r so CRLF files render cleanly
  let text = src.slice(lineStart, lineEnd);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return {
    line: lo + 1,            // 1-based
    // col in UTF-16 code units: a JS string index into `text`, used by the
    // highlight math. bcol in bytes: what gets printed — vim's grepformat %c
    // and terminals count bytes, so non-ASCII text before the match would
    // otherwise land the cursor short.
    col: offset - lineStart + 1, // 1-based
    bcol: Buffer.byteLength(src.slice(lineStart, offset), 'utf8') + 1, // 1-based
    text,
  };
}

// Text of a 1-based line number, with the trailing \r stripped (CRLF), plus the
// line's byte start (so a node's offset maps to a column within it).
function lineTextAt(starts, src, lineNo) {
  const lineStart = starts[lineNo - 1];
  let lineEnd = src.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = src.length;
  let text = src.slice(lineStart, lineEnd);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return { lineStart, text };
}

function truncate(text, maxWidth) {
  if (!maxWidth || text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + '…'; // …
}

// Produce the visible match text: truncate first (so --max-width still measures
// real columns, never escape sequences), then — when coloring — wrap the part
// of the matched node that falls on this line in the match color. A node can
// span multiple lines while we only print its opening line, so the highlight is
// clamped to what's visible; a match scrolled past the truncation point isn't
// highlighted at all (and the trailing ellipsis is never colored).
function renderText(pos, off, nodeEnd, opts) {
  const vis = truncate(pos.text, opts.maxWidth);
  if (!opts.colorOn) return vis;
  const truncated = opts.maxWidth && pos.text.length > opts.maxWidth;
  const effLen = truncated ? Math.max(0, opts.maxWidth - 1) : vis.length;
  let s = pos.col - 1;             // match start within the line (0-based)
  let e = s + (nodeEnd - off);     // match end within the line
  s = Math.max(0, Math.min(s, effLen));
  e = Math.max(s, Math.min(e, effLen));
  if (e <= s) return vis;          // nothing of the match is visible
  return vis.slice(0, s) + paint(COLORS.match, vis.slice(s, e)) + vis.slice(e);
}

// Concatenate the text of a node and all its descendants (dependency-free,
// rather than pulling in domutils). Used by --text.
function textOf(node) {
  if (node.type === 'text') return node.data || '';
  if (!node.children) return '';
  let s = '';
  for (const child of node.children) s += textOf(child);
  return s;
}

const collapseWs = s => s.replace(/\s+/g, ' ').trim();

const isElement = n => n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');

// Climb n element levels from el, clamping at the document root.
function ancestor(el, n) {
  let node = el;
  for (let k = 0; k < n; k++) {
    if (!isElement(node.parent)) break;
    node = node.parent;
  }
  return node;
}

// --parent re-points each match to its n-th ancestor; dedup by identity so a
// shared container is reported once, preserving first-seen order.
function retarget(nodes, opts) {
  if (!opts.parent) return nodes;
  const seen = new Set();
  const result = [];
  for (const el of nodes) {
    const a = ancestor(el, opts.parent);
    if (!seen.has(a)) { seen.add(a); result.push(a); }
  }
  return result;
}

// Sentinels marking where a highlighted node begins/ends. They are injected as
// HTML *comment* nodes (not text) so js-beautify keeps the surrounding block
// layout — text markers would make adjacent block elements collapse inline.
// The private-use payload can't occur in real content, so it never collides.
// After beautifying, each `<!--…-->` marker is swapped for an ANSI code.
const HL_START = '';
const HL_END = '';

// Re-indent a matched node's HTML from scratch (so minified input still comes
// out readable). dom-serializer turns the parsed node back into a string;
// js-beautify does the formatting. When `origins` (descendant nodes to
// highlight) is given and coloring is on, those nodes are wrapped in the match
// color within the printed block.
function prettyPrint(el, origins, opts) {
  const highlight = origins && origins.length && opts && opts.colorOn;
  const inserted = [];
  if (highlight) {
    // Bracket each origin with sentinel comment nodes among its siblings.
    for (const m of origins) {
      if (!m.parent) continue;
      const kids = m.parent.children;
      const i = kids.indexOf(m);
      if (i < 0) continue;
      const start = { type: 'comment', data: HL_START };
      const end = { type: 'comment', data: HL_END };
      kids.splice(i, 0, start);
      kids.splice(i + 2, 0, end);
      inserted.push({ kids, start, end });
    }
  }
  let html;
  try {
    html = beautify(render(el, { encodeEntities: false }), {
      indent_size: 2,
      wrap_line_length: 0, // never wrap long lines (e.g. long text/attributes)
      preserve_newlines: false,
    });
  } finally {
    // Always restore the DOM so the markers don't leak into later matches.
    for (const { kids, start, end } of inserted) {
      let k = kids.indexOf(start); if (k >= 0) kids.splice(k, 1);
      k = kids.indexOf(end); if (k >= 0) kids.splice(k, 1);
    }
  }
  if (!highlight) return html;
  const startCode = `\x1b[${COLORS.match}m`;
  const resetCode = '\x1b[0m';
  html = html
    .replace(new RegExp(`<!--\\s*${HL_START}\\s*-->`, 'g'), startCode)
    .replace(new RegExp(`<!--\\s*${HL_END}\\s*-->`, 'g'), resetCode);
  return foldStandaloneCodes(html, startCode, resetCode);
}

// beautify sometimes parks a marker comment on its own line (e.g. when the
// matched node followed source whitespace), leaving a line of just indent + a
// zero-width ANSI code — a spurious blank line. Fold such a code onto the
// adjacent content line: a start code onto the next line, a reset onto the
// previous one.
function foldStandaloneCodes(html, startCode, resetCode) {
  const lines = html.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)(\x1b\[[0-9;]*m)[ \t]*$/);
    if (m) {
      const code = m[2];
      if (code === startCode && i + 1 < lines.length) {
        lines[i + 1] = lines[i + 1].replace(/^[ \t]*/, ws => ws + startCode);
        continue; // drop the standalone line
      }
      if (code === resetCode && out.length) {
        out[out.length - 1] += resetCode;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// -A/-B/-C: emit each match line plus its surrounding context lines, grep-style.
// Match lines use `:` field separators and keep the match-node highlight;
// context lines use `-` and no highlight. Overlapping context windows merge,
// and `--` separates non-contiguous groups.
function emitContext(src, starts, name, showLabel, targets, opts, out) {
  const label = showLabel ? name : null;
  const c = opts.colorOn ? paint : (_, s) => s;
  const lineCount = src.length === 0 ? 0 : (src.endsWith('\n') ? starts.length - 1 : starts.length);

  // Map each match line to a representative node span (the first match on it),
  // which drives the in-line highlight when coloring.
  const info = new Map();
  for (const el of targets) {
    const off = el.startIndex == null ? 0 : el.startIndex;
    const pos = offsetToPosition(starts, src, off);
    if (info.has(pos.line)) continue;
    const nodeEnd = (el.endIndex == null ? off : el.endIndex) + 1;
    info.set(pos.line, { off, nodeEnd, pos });
  }

  // Expand match lines to [L-before, L+after] windows and merge adjacent ones.
  const ranges = [];
  for (const L of [...info.keys()].sort((a, b) => a - b)) {
    const lo = Math.max(1, L - opts.before);
    const hi = Math.min(lineCount, L + opts.after);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else ranges.push({ lo, hi });
  }

  let firstGroup = true;
  for (const { lo, hi } of ranges) {
    if (!firstGroup) out.push('--');
    firstGroup = false;
    for (let L = lo; L <= hi; L++) {
      const m = info.get(L);
      const sepColored = c(COLORS.sep, m ? ':' : '-');
      let prefix = '';
      if (label) prefix += c(COLORS.file, label) + (opts.nul ? '\0' : sepColored);
      if (opts.lineNumber) {
        prefix += c(COLORS.line, String(L));
        prefix += m ? c(COLORS.sep, ':') + c(COLORS.line, String(m.pos.bcol)) + ' '
                    : c(COLORS.sep, '-');
      }
      const body = m
        ? renderText(m.pos, m.off, m.nodeEnd, opts)        // highlight + truncate
        : truncate(lineTextAt(starts, src, L).text, opts.maxWidth);
      out.push(prefix + body);
    }
  }
}

// `name` is the source's display name (file path, or "(standard input)"); it is
// used by the aggregate modes (-l/-L/-c). `showLabel` decides whether per-match
// lines carry a `file:` prefix (only when more than one file is searched).
function searchSource(src, name, showLabel, opts, out, limit = Infinity) {
  const dom = parseDocument(src, {
    withStartIndices: true,
    withEndIndices: true,
  });
  const matches = selectAll(opts.selector, dom);
  const found = matches.length;
  // Aggregate modes suppress per-match output entirely.
  if (opts.quiet) return found;                                  // status only
  if (opts.filesWithMatches) { if (found) out.push(name); return found; }
  if (opts.filesWithoutMatch) { if (!found) out.push(name); return found; }

  const label = showLabel ? name : null;
  // -m/--max-count caps matches per source; `limit` is the remaining global
  // budget from -M/--max-total (Infinity when neither applies).
  const cap = Math.min(opts.maxCount || Infinity, limit);
  const limited = Number.isFinite(cap) ? matches.slice(0, cap) : matches;
  if (opts.count) {
    if (limited.length) {
      const fileSep = opts.nul ? '\0' : ':';
      out.push(label ? `${label}${fileSep}${limited.length}` : String(limited.length));
    }
    return limited.length;
  }
  const starts = opts.print ? null : lineIndex(src);
  // --parent re-targets matches to ancestors (no-op without it). Aggregate
  // modes above operate on the raw matches; targeting only affects what prints.
  const targets = retarget(limited, opts);
  // For --parent + -p, remember which original matches sit under each ancestor
  // so they can be highlighted inside the printed container.
  const originsByTarget = new Map();
  if (opts.parent && opts.print) {
    for (const el of limited) {
      const a = ancestor(el, opts.parent);
      if (!originsByTarget.has(a)) originsByTarget.set(a, []);
      originsByTarget.get(a).push(el);
    }
  }
  if (opts.before > 0 || opts.after > 0) {
    emitContext(src, starts, name, showLabel, targets, opts, out);
    return limited.length;
  }
  // From here on the return value is the number of *emitted* records (which is
  // what the -M budget and the exit status should count): --attr can skip
  // matches lacking the attribute, and --parent dedup can merge several
  // matches into one printed ancestor.
  if (opts.json) {
    // NDJSON: one self-contained record per match. `html` is the exact source
    // slice; newlines are escaped by JSON.stringify, so each record stays on
    // one line. Ignores --color and -n (line/col are always present).
    for (const el of targets) {
      const off = el.startIndex == null ? 0 : el.startIndex;
      const pos = offsetToPosition(starts, src, off);
      const nodeEnd = (el.endIndex == null ? off : el.endIndex) + 1;
      out.push(JSON.stringify({
        file: name,
        line: pos.line,
        col: pos.bcol,
        html: src.slice(off, nodeEnd),
        text: collapseWs(textOf(el)),
      }));
    }
    return targets.length;
  }
  let emitted = 0;
  for (const el of targets) {
    if (opts.print) {
      // -p shows the re-indented node only; no line:col locator. With --parent,
      // the original matched descendants are highlighted inside the container.
      out.push(prettyPrint(el, originsByTarget.get(el), opts), ''); // blank separator
      emitted++;
      continue;
    }
    const off = el.startIndex == null ? 0 : el.startIndex;
    const pos = offsetToPosition(starts, src, off);
    const c = opts.colorOn ? paint : (_, s) => s;

    // Choose the content printed for this match. --attr/--text replace the
    // source line with the extracted value (whole value highlighted as the
    // match); both honor -w truncation. Nodes lacking the attribute are skipped.
    let text;
    if (opts.attr != null) {
      if (!el.attribs || !(opts.attr in el.attribs)) continue;
      text = c(COLORS.match, truncate(el.attribs[opts.attr], opts.maxWidth));
    } else if (opts.text) {
      text = c(COLORS.match, truncate(collapseWs(textOf(el)), opts.maxWidth));
    } else {
      const nodeEnd = (el.endIndex == null ? off : el.endIndex) + 1; // exclusive
      text = renderText(pos, off, nodeEnd, opts);
    }
    // grep-style: a `file:` prefix appears with multiple files; the line:col
    // locator only with -n. The locator is separated from the text by a space
    // so the output stays :grep-compatible (grepformat %f:%l:%c %m).
    const sep = c(COLORS.sep, ':');
    // -0/--null: the char after the file name becomes NUL (grep -Z), for
    // unambiguous machine parsing (e.g. xargs -0).
    const fileSep = opts.nul ? '\0' : sep;
    let prefix = '';
    if (label) prefix += c(COLORS.file, label) + fileSep;
    if (opts.lineNumber) {
      prefix += c(COLORS.line, String(pos.line)) + sep + c(COLORS.line, String(pos.bcol)) + ' ';
    }
    out.push(prefix + text);
    emitted++;
  }
  return emitted;
}

// Translate a glob to a regex body. `*` matches within a path segment, `**`
// across segments, `?` a single non-slash char, `{a,b,c}` alternation; every
// other char is literal.
function globToRegex(glob) {
  let re = '';
  let depth = 0;                            // open `{` alternation groups
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {            // **  (crosses /)
        i++;
        if (glob[i + 1] === '/') {
          // `**/` spans whole segments (or none): `**/foo` matches `foo` and
          // `a/b/foo`, but not `barfoo` — the `.*` must end at a `/`.
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(';
      depth++;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else if (/[.+^$()|[\]\\]/.test(c)) {  // note: { } handled above
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  while (depth-- > 0) re += ')';            // close any unbalanced `{`
  return re;
}

// Compile one ignore pattern (gitignore-flavored). A trailing `/` makes it
// match directories only; a pattern containing `/` matches against the path
// (anchored at a segment boundary), otherwise against the basename.
function compileIgnore(pattern) {
  const p = pattern.trim().replace(/\/$/, '');
  if (!p || pattern.trim().startsWith('#')) return null;  // blank / comment line
  const dirOnly = /\/$/.test(pattern.trim());
  const hasSlash = p.includes('/');
  const body = globToRegex(p);
  const re = hasSlash ? new RegExp('(^|/)' + body + '$') : new RegExp('^' + body + '$');
  return { re, dirOnly, hasSlash };
}

// True if name/path matches any compiled glob matcher (shared by --ignore/
// --exclude and --include).
function matchesAny(name, full, isDir, matchers) {
  for (const m of matchers) {
    if (m.dirOnly && !isDir) continue;
    if (m.re.test(m.hasSlash ? full : name)) return true;
  }
  return false;
}

function* walk(dir, opts, depth = 1) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (!opts.noMessages) process.stderr.write(`cssgrep: ${dir}: ${e.code || e.message}\n`);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const isDir = e.isDirectory();
    if (opts.ignore.length && matchesAny(e.name, full, isDir, opts.ignore)) continue;
    if (isDir) {
      // --max-depth caps how far we descend; depth 1 = the target's children.
      if (!opts.maxDepth || depth < opts.maxDepth) yield* walk(full, opts, depth + 1);
    } else if (e.isFile()) {
      // --include replaces the extension filter; otherwise filter by --ext.
      if (opts.include.length) {
        if (matchesAny(e.name, full, false, opts.include)) yield full;
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (opts.exts.includes(ext)) yield full;
      }
    }
  }
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// Heuristic binary-file detector (grep/git style). A NUL byte in the first 8 KB
// is a decisive binary signal; failing that, a high ratio of non-text control
// bytes flags binary content that happens to lack NULs. HTML is text, so binary
// files are never worth parsing and are skipped. (stat() can't tell us this —
// only the bytes can.)
const BINARY_SNIFF_BYTES = 8192;
function looksBinary(buf) {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;                       // NUL: definitely binary
    if (b < 9 || (b > 13 && b < 32)) suspicious++;  // control char (not \t\n\v\f\r)
  }
  return n > 0 && suspicious / n > 0.3;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  resolveSelectorAndPaths(opts);

  // Resolve the list of files to search.
  let files = [];
  let useStdin = false;
  if (opts.recursive) {
    // No path given with -r means "search here", like ripgrep.
    const targets = opts.paths.length ? opts.paths : ['.'];
    for (const p of targets) {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (!st) { if (!opts.noMessages) process.stderr.write(`cssgrep: ${p}: no such file or directory\n`); continue; }
      if (st.isDirectory()) files.push(...walk(p, opts));
      else files.push(p);
    }
  } else if (opts.paths.length > 0) {
    files = opts.paths;
  } else {
    useStdin = true;
  }

  // A label (file prefix) is shown when searching more than one file; -H forces
  // it on (even for one file or stdin) and --no-filename forces it off.
  const showLabel = opts.withFilename ? true
    : opts.noFilename ? false
    : (!useStdin && files.length > 1);

  const out = [];
  let total = 0;

  // -M/--max-total: remaining matches allowed across all files (Infinity = off).
  const room = () => (opts.maxTotal ? Math.max(0, opts.maxTotal - total) : Infinity);

  try {
    if (useStdin) {
      total += searchSource(readStdin(), '(standard input)', showLabel, opts, out, room());
    } else {
      for (const f of files) {
        if (room() <= 0) break;               // -M: global budget exhausted
        let buf;
        try {
          buf = fs.readFileSync(f);           // Buffer: sniff before decoding
        } catch (e) {
          if (!opts.noMessages) process.stderr.write(`cssgrep: ${f}: ${e.code || e.message}\n`);
          continue;
        }
        if (looksBinary(buf)) {
          if (!opts.noMessages && !opts.quiet) {
            process.stderr.write(`cssgrep: ${f}: binary file (skipped)\n`);
          }
          continue;
        }
        total += searchSource(buf.toString('utf8'), f, showLabel, opts, out, room());
        if (opts.quiet && total > 0) break;   // -q: first match decides the status
      }
    }
  } catch (e) {
    if (e && e.message && /selector|tokeniz|parse/i.test(e.message)) {
      fail(`invalid selector: ${opts.selector}`);
    }
    fail(e.message);
  }

  if (out.length) {
    // For -l/-L, -0 NUL-terminates each file name (no newline) so the list is
    // safe for `xargs -0`. Other modes keep newline-separated records (with -0
    // the NUL appears only as the in-record file-name separator).
    if (opts.nul && (opts.filesWithMatches || opts.filesWithoutMatch)) {
      process.stdout.write(out.map(s => s + '\0').join(''));
    } else {
      process.stdout.write(out.join('\n') + '\n');
    }
  }
  // Normally success means "a match was found". With -L it means "a file
  // without a match was printed", which is decoupled from the match total.
  // Set exitCode rather than calling process.exit(): stdout writes to a pipe
  // are async, and exit() would drop whatever hasn't flushed yet, truncating
  // large result sets mid-stream.
  const success = opts.filesWithoutMatch ? out.length > 0 : total > 0;
  process.exitCode = success ? 0 : 1;
}

main();
