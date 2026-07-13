'use strict';

// cssgrep's engine as a library. The public API is `parse(html)`: parse an
// HTML string once (with source positions) and get back a document handle
// whose `search(selector, opts)` can run any number of selectors against the
// same tree — parse once, query many. The CLI (cli.js) is a consumer of this
// API; everything here is string-in/data-out — file discovery, output
// formatting and process concerns live in the CLI.
//
// Stability contract: `parse`, the document's `html`/`search`, and the match
// fields are the public surface. Each match also carries `node`, the raw
// htmlparser2 element, as an advanced escape hatch — its shape belongs to
// htmlparser2, not to cssgrep. The document's `dom`/`lineStarts`/`position`
// and the other module exports are internals shared with the CLI.

const { parseDocument } = require('htmlparser2');
const { selectAll } = require('css-select');

// Precompute the offset at which each line starts, so offset->line/col is a
// binary search rather than a re-scan per match.
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function offsetToPosition(starts, src, offset, state) {
  // binary search for the greatest line start <= offset
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const lineStart = starts[lo];
  // The next line's start bounds this line (O(1)); an indexOf scan here is
  // O(line length) *per match* — quadratic on minified single-line files.
  const lineEnd = lo + 1 < starts.length ? starts[lo + 1] - 1 : src.length;
  // strip a trailing \r so CRLF files render cleanly
  let text = src.slice(lineStart, lineEnd);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  // bcol counts bytes from the line start — also quadratic if recomputed per
  // match. `state` (one mutable object per source, supplied by the caller)
  // remembers the previous match's byte count, so in-order matches on the
  // same line pay only the delta; out-of-order falls back to a full count.
  let bytes;
  if (state && state.lineStart === lineStart && offset >= state.offset) {
    bytes = state.bytes + Buffer.byteLength(src.slice(state.offset, offset), 'utf8');
  } else {
    bytes = Buffer.byteLength(src.slice(lineStart, offset), 'utf8');
  }
  if (state) {
    state.lineStart = lineStart;
    state.offset = offset;
    state.bytes = bytes;
  }
  return {
    line: lo + 1,            // 1-based
    // col in UTF-16 code units: a JS string index into `text`, used by the
    // highlight math. bcol in bytes: what gets printed — vim's grepformat %c
    // and terminals count bytes, so non-ASCII text before the match would
    // otherwise land the cursor short.
    col: offset - lineStart + 1, // 1-based
    bcol: bytes + 1,             // 1-based
    text,
  };
}

// Text of a 1-based line number, with the trailing \r stripped (CRLF), plus the
// line's byte start (so a node's offset maps to a column within it).
function lineTextAt(starts, src, lineNo) {
  const lineStart = starts[lineNo - 1];
  const lineEnd = lineNo < starts.length ? starts[lineNo] - 1 : src.length;
  let text = src.slice(lineStart, lineEnd);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return { lineStart, text };
}

// Concatenate the text of a node and all its descendants (dependency-free,
// rather than pulling in domutils).
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

// `parent` re-points each match to its n-th ancestor; dedup by identity so a
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

// --- embedded HTML (JS/TS template literals) -----------------------------------

// Replace every char except line breaks with a space: masked text has the
// same length AND the same line structure as the original, so offsets and
// the host file's line index stay valid.
const maskWs = s => s.replace(/[^\n\r]/g, ' ');

// Skip a '...' or "..." string; `i` is at the opening quote. Returns the
// index just past the closing quote (or line end / EOF for unterminated).
function skipJsString(src, i) {
  const quote = src[i++];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (c === '\n') return i;              // unterminated: resync at newline
    i++;
  }
  return i;
}

// Skip code until the '}' that closes a template hole (depth-balanced),
// recursing into strings, comments and nested template literals — a nested
// literal contributes its own fragments. `i` is just past '${'.
function skipJsCode(src, i, fragments) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipJsString(src, i); continue; }
    if (c === '`') { i = readTemplate(src, i, fragments); continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return src.length;
      i = nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return src.length;
      i = end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return i;
}

// Read one template literal; `i` is at the opening backtick. Masks every
// `${…}` hole to same-length whitespace and, when the masked content sniffs
// as markup (`<` + letter, or `<!`), records it as a fragment. Returns the
// index just past the closing backtick. Nested literals inside holes are
// processed first, so their fragments are collected too.
function readTemplate(src, i, fragments) {
  const contentStart = ++i;
  const holes = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') break;
    if (c === '$' && src[i + 1] === '{') {
      const holeStart = i;
      i = skipJsCode(src, i + 2, fragments);
      holes.push([holeStart, i]);
      continue;
    }
    i++;
  }
  const contentEnd = Math.min(i, src.length);
  let masked = src.slice(contentStart, contentEnd);
  for (const [hs, he] of holes) {
    const a = hs - contentStart;
    const b = Math.min(he, contentEnd) - contentStart;
    masked = masked.slice(0, a) + maskWs(masked.slice(a, b)) + masked.slice(b);
  }
  if (/<[a-zA-Z!]/.test(masked)) fragments.push({ start: contentStart, masked });
  return contentEnd + 1;
}

// Scan JS/TS source for template literals whose content looks like markup.
// Returns fragments of { start, masked }: `start` is the host-file offset of
// the literal's content, `masked` its text with `${…}` holes blanked to
// same-length whitespace — so every fragment offset IS a host offset.
// String, template and comment contexts are tracked; regex literals are not
// (a backtick inside a regex could mislead the scan — rare, and a mislead
// degrades to "no fragment", never to wrong positions of what is found).
function extractHtmlFragments(src) {
  const fragments = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipJsString(src, i); continue; }
    if (c === '`') { i = readTemplate(src, i, fragments); continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    i++;
  }
  return fragments;
}

// --- rewrite machinery --------------------------------------------------------

// Lex one opening tag starting at `start` (which must point at its `<`).
// htmlparser2 records node offsets but not attribute offsets, so this tiny
// lexer recovers the spans transform() needs. Quoted attribute values may
// contain `>`; `/` acts as whitespace (self-closing slash, sloppy `a/b`).
// Returns { nameStart, nameEnd, attrs, end } — offsets into `src`, `end` just
// past the closing `>`; each attr is { name, start, end, nameEnd, vStart,
// vEnd } (vStart -1 for valueless attributes; value offsets exclude quotes).
function lexOpenTag(src, start) {
  let i = start + 1;
  const nameStart = i;
  while (i < src.length && !/[\s/>]/.test(src[i])) i++;
  const nameEnd = i;
  const attrs = [];
  for (;;) {
    while (i < src.length && /[\s/]/.test(src[i])) i++;
    if (i >= src.length || src[i] === '>') break;
    const aStart = i;
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++;
    const aNameEnd = i;
    let vStart = -1, vEnd = -1;
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '=') {
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") {
        const quote = src[j];
        vStart = ++j;
        while (j < src.length && src[j] !== quote) j++;
        vEnd = j;
        if (j < src.length) j++;            // past the closing quote
      } else {
        vStart = j;
        while (j < src.length && !/[\s>]/.test(src[j])) j++;
        vEnd = j;
      }
      i = j;
    }
    attrs.push({
      name: src.slice(aStart, aNameEnd),
      start: aStart,
      end: vStart === -1 ? aNameEnd : i,
      nameEnd: aNameEnd,
      vStart,
      vEnd,
    });
  }
  return { nameStart, nameEnd, attrs, end: i + 1 };
}

const escAttr = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Each helper takes the opening tag's source text and returns it edited (or
// unchanged). They re-lex per call — the string is one tag, so that's cheap —
// which lets ops compose sequentially without span bookkeeping.

function removeAttrFromTag(t, name) {
  const lc = name.toLowerCase();
  for (;;) {                                // all occurrences (source may dupe)
    const a = lexOpenTag(t, 0).attrs.find(a => a.name.toLowerCase() === lc);
    if (!a) return t;
    let ws = a.start;
    while (ws > 0 && /\s/.test(t[ws - 1])) ws--;
    t = t.slice(0, ws) + t.slice(a.end);
  }
}

function setAttrInTag(t, name, value) {
  const lc = name.toLowerCase();
  const a = lexOpenTag(t, 0).attrs.find(a => a.name.toLowerCase() === lc);
  const rendered = `${name}="${escAttr(value)}"`;
  if (a) return t.slice(0, a.start) + rendered + t.slice(a.end);
  const tail = /\s*\/?>$/.exec(t);
  return t.slice(0, tail.index) + ' ' + rendered + t.slice(tail.index);
}

// Class edits rewrite the whole class attribute (original name case kept,
// value re-quoted with `"`) — the one attribute being edited is normalized,
// every other byte of the tag stays put.
function classEdit(t, mutate) {
  const a = lexOpenTag(t, 0).attrs.find(a => a.name.toLowerCase() === 'class');
  const tokens = a && a.vStart >= 0
    ? t.slice(a.vStart, a.vEnd).split(/\s+/).filter(Boolean)
    : [];
  const next = mutate(tokens);
  if (next === null) return t;              // no change
  if (!a) return setAttrInTag(t, 'class', next.join(' '));
  if (next.length === 0) return removeAttrFromTag(t, t.slice(a.start, a.nameEnd));
  return t.slice(0, a.start)
    + `${t.slice(a.start, a.nameEnd)}="${next.join(' ')}"`
    + t.slice(a.end);
}

const addClassToTag = (t, cls) =>
  classEdit(t, tokens => (tokens.includes(cls) ? null : [...tokens, cls]));

const removeClassFromTag = (t, cls) =>
  classEdit(t, tokens => (tokens.includes(cls) ? tokens.filter(c => c !== cls) : null));

// Validate and normalize a transform ops object. Names must not be able to
// break out of the tag or its quoting; values are escaped at render time.
const OP_KEYS = ['renameTag', 'removeAttr', 'setAttr', 'removeClass', 'addClass', 'parent'];
const TAG_NAME = /^[a-zA-Z][^\s/>'"=]*$/;
const ATTR_NAME = /^[^\s/>'"=]+$/;
const CLASS_TOKEN = /^[^\s'"&<>]+$/;

function normalizeOps(ops) {
  for (const k of Object.keys(ops)) {
    if (!OP_KEYS.includes(k)) throw new TypeError(`unknown transform op: ${k}`);
  }
  const toArr = v => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);
  const norm = {
    renameTag: ops.renameTag != null ? String(ops.renameTag) : null,
    removeAttr: toArr(ops.removeAttr),
    setAttr: {},
    removeClass: toArr(ops.removeClass),
    addClass: toArr(ops.addClass),
    parent: ops.parent || 0,
  };
  if (ops.parent != null && (!Number.isInteger(ops.parent) || ops.parent < 0)) {
    throw new TypeError('parent must be a non-negative integer');
  }
  if (norm.renameTag !== null && !TAG_NAME.test(norm.renameTag)) {
    throw new TypeError(`invalid tag name: ${norm.renameTag}`);
  }
  for (const k of norm.removeAttr) {
    if (!ATTR_NAME.test(k)) throw new TypeError(`invalid attribute name: ${k}`);
  }
  if (ops.setAttr != null) {
    if (typeof ops.setAttr !== 'object' || Array.isArray(ops.setAttr)) {
      throw new TypeError('setAttr must be an object of name: value');
    }
    for (const [k, v] of Object.entries(ops.setAttr)) {
      if (!ATTR_NAME.test(k)) throw new TypeError(`invalid attribute name: ${k}`);
      norm.setAttr[k] = String(v);
    }
  }
  for (const c of [...norm.removeClass, ...norm.addClass]) {
    if (!CLASS_TOKEN.test(c)) throw new TypeError(`invalid class name: ${c}`);
  }
  const count = (norm.renameTag ? 1 : 0) + norm.removeAttr.length
    + Object.keys(norm.setAttr).length + norm.removeClass.length + norm.addClass.length;
  if (count === 0) throw new TypeError('no transform operations given');
  return norm;
}

// Ops compose in a fixed documented pipeline order — deterministic no matter
// how the caller (or argv) ordered them: rename → remove-attr → set-attr →
// remove-class → add-class.
function applyOpsToOpenTag(t, ops) {
  if (ops.renameTag) {
    const lx = lexOpenTag(t, 0);
    t = t.slice(0, lx.nameStart) + ops.renameTag + t.slice(lx.nameEnd);
  }
  for (const k of ops.removeAttr) t = removeAttrFromTag(t, k);
  for (const [k, v] of Object.entries(ops.setAttr)) t = setAttrInTag(t, k, v);
  for (const c of ops.removeClass) t = removeClassFromTag(t, c);
  for (const c of ops.addClass) t = addClassToTag(t, c);
  return t;
}

// Parse an HTML string once and return a document handle. `search(selector,
// opts)` can then run any number of selectors against the same tree — the
// parse and the line index are paid once per document, not per query.
//
// Each search returns one match object per hit, in DOM order:
//
//   { start, end, line, col, tag, attribs, html, text, node }
//
// - start/end: 0-based offsets of the node in `html` (end exclusive), so
//   `html.slice(start, end)` is the exact source of the match.
// - line/col: 1-based position of the opening `<`; col counts *bytes* (what
//   vim's grepformat %c expects), matching the CLI's -n output.
// - tag: lowercased tag name; attribs: a fresh plain object copy.
// - html: the exact source slice; text: collapsed text content.
// - node: the raw htmlparser2 element (advanced/unstable escape hatch).
//
// line/col/html/text are lazy getters — a match costs nothing for fields
// never read (aggregate-style consumers skip the position math entirely),
// while JSON.stringify still serializes complete records.
//
// opts.parent (n >= 1) re-targets each match to its n-th element ancestor,
// deduplicated by identity — the CLI's --parent.
//
// parse throws on non-string input; search throws on selectors css-select
// cannot parse.
function parse(html) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  const dom = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  });
  let starts = null;
  const lineStarts = () => starts || (starts = lineIndex(html));
  const posState = {};   // incremental byte-column cache, scoped to this doc
  const position = offset => offsetToPosition(lineStarts(), html, offset, posState);
  return {
    html,
    // Internal (unstable): the raw htmlparser2 document and the cached
    // line-index helpers, shared with the CLI.
    dom,
    lineStarts,
    position,
    search(selector, opts = {}) {
      if (typeof selector !== 'string' || selector.trim() === '') {
        throw new TypeError('selector must be a non-empty string');
      }
      if (opts.parent != null && (!Number.isInteger(opts.parent) || opts.parent < 0)) {
        throw new TypeError('opts.parent must be a non-negative integer');
      }
      const targets = retarget(selectAll(selector, dom), { parent: opts.parent || 0 });
      return targets.map(el => {
        const start = el.startIndex == null ? 0 : el.startIndex;
        const end = (el.endIndex == null ? start : el.endIndex) + 1; // exclusive
        const match = {
          start,
          end,
          tag: el.name,
          attribs: el.attribs ? { ...el.attribs } : {},
          get line() { return position(start).line; },
          get col() { return position(start).bcol; },
          get html() { return html.slice(start, end); },
          get text() { return collapseWs(textOf(el)); },
        };
        // The escape hatch is a reference, not data: htmlparser2 nodes link
        // parent/children circularly, so keep `node` non-enumerable to let
        // JSON.stringify serialize matches cleanly.
        Object.defineProperty(match, 'node', { value: el });
        return match;
      });
    },
    // Rewrite the elements matched by `selector` and return { html, edits }:
    // the edited document plus one splice record per changed span
    // ({ start, end, before, after }, offsets into the ORIGINAL html). Only
    // the matched tags' bytes change — everything else passes through
    // untouched (the fidelity contract; see ROADMAP Phase 9).
    //
    // ops: { renameTag, removeAttr, setAttr, removeClass, addClass, parent }.
    // Scalars or arrays where it makes sense; ops compose in the fixed
    // pipeline order rename → remove-attr → set-attr → remove-class →
    // add-class regardless of key order. The selector runs once against the
    // parsed tree; edits never re-match. Throws on invalid selectors, op
    // names, or an empty ops object.
    transform(selector, ops = {}) {
      if (typeof selector !== 'string' || selector.trim() === '') {
        throw new TypeError('selector must be a non-empty string');
      }
      const norm = normalizeOps(ops);
      const targets = retarget(selectAll(selector, dom), { parent: norm.parent });
      const edits = [];
      for (const el of targets) {
        if (el.startIndex == null) continue;
        const start = el.startIndex;
        const open = lexOpenTag(html, start);
        const before = html.slice(start, open.end);
        const after = applyOpsToOpenTag(before, norm);
        if (after !== before) edits.push({ start, end: open.end, before, after });
        if (norm.renameTag) {
          // Rename the closing tag too — but only when one explicitly exists:
          // voids (<img>), self-closing (<x/>) and parser-implied closes
          // (<li> without </li>) end without their own </name>.
          const nodeEnd = (el.endIndex == null ? start : el.endIndex) + 1;
          const m = /<\/([^\s>]+)(\s*)>$/.exec(html.slice(start, nodeEnd));
          if (m && m[1].toLowerCase() === el.name) {
            edits.push({
              start: start + m.index,
              end: nodeEnd,
              before: m[0],
              after: `</${norm.renameTag}${m[2]}>`,
            });
          }
        }
      }
      edits.sort((a, b) => a.start - b.start);
      for (let i = 1; i < edits.length; i++) {
        if (edits[i].start < edits[i - 1].end) {
          throw new Error('internal error: overlapping edits');
        }
      }
      let out = html;
      for (let i = edits.length - 1; i >= 0; i--) {
        out = out.slice(0, edits[i].start) + edits[i].after + out.slice(edits[i].end);
      }
      return { html: out, edits };
    },
  };
}

module.exports = {
  parse,
  // Internal helpers, shared with cli.js; not part of the stable API.
  extractHtmlFragments,
  lexOpenTag,
  lineIndex,
  offsetToPosition,
  lineTextAt,
  textOf,
  collapseWs,
  isElement,
  ancestor,
  retarget,
};
