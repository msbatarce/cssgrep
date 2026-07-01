#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseDocument } = require('htmlparser2');
const { selectAll } = require('css-select');
const render = require('dom-serializer').default;
const { html: beautify } = require('js-beautify');

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
      --ext <list>       Comma-separated extensions for -r (default: html,htm).
  -n, --line-number      Prefix each match with its line:col (excludes -c, -p).
  -p, --print            Pretty-print the matched node's HTML above its location.
  -w, --max-width <n>    Truncate the shown line to <n> columns (ellipsis added).
  -c, --count            Print only a count of matches (per file when relevant).
      --color[=<when>]   Colorize output: auto (default), always or never.
  -h, --help             Show this help.

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
    lineNumber: false,
    print: false,
    maxWidth: 0,
    count: false,
    color: 'auto',
  };
  const setExts = v => {
    opts.exts = (v || '').split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);
  };
  const setMaxWidth = v => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) fail('invalid --max-width value');
    opts.maxWidth = n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Long options: --name or --name=value. A missing inline value is taken
    // from the next argument (except --color, where a bare flag means "always").
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      const value = () => (inline != null ? inline : argv[++i]);
      switch (name) {
        case '--help': process.stdout.write(USAGE + '\n'); process.exit(0); break;
        case '--recursive': opts.recursive = true; break;
        case '--line-number': opts.lineNumber = true; break;
        case '--print': opts.print = true; break;
        case '--count': opts.count = true; break;
        case '--ext': setExts(value()); break;
        case '--max-width': setMaxWidth(value()); break;
        case '--color': case '--colour': opts.color = inline != null ? inline : 'always'; break;
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
        if (ch === 'h') { process.stdout.write(USAGE + '\n'); process.exit(0); }
        else if (ch === 'r') opts.recursive = true;
        else if (ch === 'n') opts.lineNumber = true;
        else if (ch === 'p') opts.print = true;
        else if (ch === 'c') opts.count = true;
        else if (ch === 'w') {
          const rest = a.slice(j + 1);          // attached value, if any
          setMaxWidth(rest !== '' ? rest : argv[++i]);
          break;                                // value swallowed the cluster tail
        }
        else fail(`unknown option: -${ch}`);
      }
      continue;
    }

    opts.positionals.push(a);
  }
  if (opts.positionals.length === 0) fail('no selector given (try --help)');
  if (opts.lineNumber && opts.count) fail('-n cannot be combined with -c');
  if (opts.lineNumber && opts.print) fail('-n cannot be combined with -p');
  if (!['auto', 'always', 'never'].includes(opts.color)) {
    fail(`invalid --color value: ${opts.color} (expected auto, always or never)`);
  }
  // Resolve the tri-state into a single boolean: color only when forced on, or
  // 'auto' and stdout is an interactive terminal. -p never colors (the node is
  // lifted out of its line, so there's no in-line match to highlight).
  opts.colorOn = !opts.print &&
    (opts.color === 'always' || (opts.color === 'auto' && Boolean(process.stdout.isTTY)));
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
    col: offset - lineStart + 1, // 1-based
    text,
  };
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

// Re-indent a matched node's HTML from scratch (so minified input still comes
// out readable). dom-serializer turns the parsed node back into a string;
// js-beautify does the formatting.
function prettyPrint(el) {
  return beautify(render(el, { encodeEntities: false }), {
    indent_size: 2,
    wrap_line_length: 0, // never wrap long lines (e.g. long text/attributes)
    preserve_newlines: false,
  });
}

function searchSource(src, label, opts, out) {
  const dom = parseDocument(src, {
    withStartIndices: true,
    withEndIndices: true,
  });
  const matches = selectAll(opts.selector, dom);
  if (opts.count) {
    if (matches.length) {
      out.push(label ? `${label}:${matches.length}` : String(matches.length));
    }
    return matches.length;
  }
  const starts = opts.print ? null : lineIndex(src);
  for (const el of matches) {
    if (opts.print) {
      // -p shows the re-indented node only; no line:col locator.
      out.push(prettyPrint(el), ''); // blank separator between matches
      continue;
    }
    const off = el.startIndex == null ? 0 : el.startIndex;
    const pos = offsetToPosition(starts, src, off);
    const nodeEnd = (el.endIndex == null ? off : el.endIndex) + 1; // exclusive
    const text = renderText(pos, off, nodeEnd, opts);
    // grep-style: a `file:` prefix appears with multiple files; the line:col
    // locator only with -n. The locator is separated from the text by a space
    // so the output stays :grep-compatible (grepformat %f:%l:%c %m).
    const c = opts.colorOn ? paint : (_, s) => s;
    const sep = c(COLORS.sep, ':');
    let prefix = '';
    if (label) prefix += c(COLORS.file, label) + sep;
    if (opts.lineNumber) {
      prefix += c(COLORS.line, String(pos.line)) + sep + c(COLORS.line, String(pos.col)) + ' ';
    }
    out.push(prefix + text);
  }
  return matches.length;
}

function* walk(dir, exts) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    process.stderr.write(`cssgrep: ${dir}: ${e.code || e.message}\n`);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, exts);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (exts.includes(ext)) yield full;
    }
  }
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
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
      if (!st) { process.stderr.write(`cssgrep: ${p}: no such file or directory\n`); continue; }
      if (st.isDirectory()) files.push(...walk(p, opts.exts));
      else files.push(p);
    }
  } else if (opts.paths.length > 0) {
    files = opts.paths;
  } else {
    useStdin = true;
  }

  // A label (file prefix) is shown when searching more than one file.
  const showLabel = !useStdin && files.length > 1;

  const out = [];
  let total = 0;

  try {
    if (useStdin) {
      total += searchSource(readStdin(), null, opts, out);
    } else {
      for (const f of files) {
        let src;
        try {
          src = fs.readFileSync(f, 'utf8');
        } catch (e) {
          process.stderr.write(`cssgrep: ${f}: ${e.code || e.message}\n`);
          continue;
        }
        total += searchSource(src, showLabel ? f : null, opts, out);
      }
    }
  } catch (e) {
    if (e && e.message && /selector|tokeniz|parse/i.test(e.message)) {
      fail(`invalid selector: ${opts.selector}`);
    }
    fail(e.message);
  }

  if (out.length) process.stdout.write(out.join('\n') + '\n');
  process.exit(total > 0 ? 0 : 1);
}

main();
