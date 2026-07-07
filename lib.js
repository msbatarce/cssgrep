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
  const position = offset => offsetToPosition(lineStarts(), html, offset);
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
  };
}

module.exports = {
  parse,
  // Internal helpers, shared with cli.js; not part of the stable API.
  lineIndex,
  offsetToPosition,
  lineTextAt,
  textOf,
  collapseWs,
  isElement,
  ancestor,
  retarget,
};
