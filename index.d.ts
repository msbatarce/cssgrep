// Type definitions for cssgrep's library API (lib.js).
//
// `parse`, the document's `html`/`search`, and the Match fields below are the
// stable public surface. `node` is an advanced escape hatch: the raw
// htmlparser2 element, whose shape belongs to htmlparser2 and may change with
// it. Other properties reachable on the document object at runtime are
// internal and unstable.

export interface SearchOptions {
  /**
   * Re-target each match to its n-th element ancestor (clamped at the
   * document root), deduplicated by identity — the CLI's --parent.
   */
  parent?: number;
}

export interface Match {
  /** 0-based offset of the node's opening `<` in the input string. */
  start: number;
  /** 0-based exclusive end offset: `doc.html.slice(start, end)` is the node. */
  end: number;
  /** 1-based line of the opening `<` (computed lazily on first read). */
  line: number;
  /** 1-based *byte* column of the opening `<` (what vim's grepformat %c expects). */
  col: number;
  /** Lowercased tag name. */
  tag: string;
  /** The node's attributes (names lowercased by the parser). */
  attribs: Record<string, string>;
  /** The exact source slice of the node (computed lazily on first read). */
  html: string;
  /** Text content, whitespace collapsed (computed lazily on first read). */
  text: string;
  /** The raw htmlparser2 element (advanced/unstable escape hatch). */
  node: unknown;
}

export interface TransformOps {
  /** Rename each matched element (its closing tag too, when one exists). */
  renameTag?: string;
  /** Attribute name(s) to remove (all source occurrences). */
  removeAttr?: string | string[];
  /** Attributes to set: value replaced or attribute added; values escaped. */
  setAttr?: Record<string, string>;
  /** Class token(s) to remove; the attribute is dropped when emptied. */
  removeClass?: string | string[];
  /** Class token(s) to add (deduplicated; attribute created if missing). */
  addClass?: string | string[];
  /** Re-target each match to its n-th element ancestor first (--parent). */
  parent?: number;
}

export interface Edit {
  /** 0-based offset in the original html where this splice starts. */
  start: number;
  /** 0-based exclusive end offset in the original html. */
  end: number;
  /** The replaced source text (`doc.html.slice(start, end)`). */
  before: string;
  /** The replacement text. */
  after: string;
}

export interface TransformResult {
  /** The rewritten document; bytes outside the edits are untouched. */
  html: string;
  /** One record per splice, in document order. Empty when nothing matched. */
  edits: Edit[];
}

export interface Document {
  /** The source string this document was parsed from. */
  html: string;
  /**
   * Run a CSS selector against the parsed tree; callable any number of times
   * per document. Returns one Match per hit in DOM order. Throws on a
   * selector css-select cannot parse.
   */
  search(selector: string, opts?: SearchOptions): Match[];
  /**
   * Rewrite the matched elements. Ops compose in a fixed pipeline order
   * (rename → remove-attr → set-attr → remove-class → add-class) regardless
   * of key order; matching runs once against the original tree. Throws on an
   * invalid selector, invalid op names, or an empty ops object.
   */
  transform(selector: string, ops: TransformOps): TransformResult;
}

/**
 * Parse an HTML string once (tracking source positions) and return a document
 * handle to query with `search`. Throws a TypeError on non-string input.
 */
export function parse(html: string): Document;
