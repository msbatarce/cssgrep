# testdata

Sample HTML for trying out and manually testing `cssgrep`. (The automated suite
in `../test.js` builds its own fixtures in a temp dir; these are for hands-on
exploration.)

| File | What it exercises |
|------|-------------------|
| `example-minified.html` | A single-line minified page — shows `line:col` works on minified HTML. |
| `blog.html` | A formatted, semantic page (header/nav/article/footer) — good for `-p`, `-A/-B/-C`, `--parent`, `--text`. |
| `links.html` | Assorted `<a>`/form/`<img>` with varied attributes — good for `--attr` and attribute selectors. |
| `cards.html` | Repeated `.card` components — good for `--parent` (de-dup), `-c`, `--json`. |
| `products-minified.html` | Minified product list — `--attr`, `-n` columns on one line. |
| `components.js` | HTML embedded in JS template literals (tagged, untagged, nested, `${…}` holes) — host-file locators with `-n`. |
| `banner.ts` | HTML embedded in TypeScript templates — same, with type annotations around the literals. |

```sh
cssgrep 'a' --attr href -n testdata/links.html
cssgrep '.price' -p --parent 1 --color=always testdata/cards.html
cssgrep '.more' -B2 -n testdata/blog.html
cssgrep '.name' --attr href testdata/products-minified.html

# embedded HTML in JS/TS — locators point into the host file
cssgrep '.price' -n testdata/components.js
cssgrep '.row' -n testdata/components.js          # nested inner templates
cssgrep '.banner .dismiss' -n testdata/banner.ts
cssgrep 'img[alt=""]' -rn --ext js,ts testdata/
```
