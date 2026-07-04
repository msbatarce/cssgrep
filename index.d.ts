// Type definitions for cssgrep's library API (lib.js).
//
// `search` and the Match fields below are the stable public surface. `node` is
// an advanced escape hatch: the raw htmlparser2 element, whose shape belongs
// to htmlparser2 and may change with it.

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
  /** 0-based exclusive end offset: `html.slice(start, end)` is the node. */
  end: number;
  /** 1-based line of the opening `<`. */
  line: number;
  /** 1-based *byte* column of the opening `<` (what vim's grepformat %c expects). */
  col: number;
  /** Lowercased tag name. */
  tag: string;
  /** The node's attributes (names lowercased by the parser). */
  attribs: Record<string, string>;
  /** The exact source slice of the node. */
  html: string;
  /** Text content with whitespace collapsed and trimmed. */
  text: string;
  /** The raw htmlparser2 element (advanced/unstable escape hatch). */
  node: unknown;
}

/**
 * Search an HTML string by CSS selector; returns one Match per hit in DOM
 * order. Throws a TypeError on non-string input and an Error on a selector
 * css-select cannot parse.
 */
export function search(html: string, selector: string, opts?: SearchOptions): Match[];
