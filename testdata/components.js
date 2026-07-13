// Sample JS with embedded HTML — for trying the embedded-template search
// (files with JS/TS extensions are scanned for HTML inside template literals;
// see the EMBEDDED HTML section of the man page).
const html = (strings, ...values) => String.raw({ raw: strings }, ...values);

// A tagged lit-html-style component: holes in attributes and content.
export function productCard(item, highlight) {
  return html`
    <div class="card ${highlight ? 'featured' : ''}">
      <h2 class="title">${item.name}</h2>
      <span class="price" data-sku="${item.sku}">${item.price}</span>
      <a class="buy" href="/buy?id=${item.id}">Add to cart</a>
    </div>`;
}

// An untagged literal assigned to innerHTML — qualifies all the same.
export function emptyState(el) {
  el.innerHTML = `
    <section class="empty">
      <img src="/img/empty.svg" alt="">
      <p class="hint">Nothing here yet.</p>
    </section>`;
}

// Nested templates: the inner <li> literals are their own fragments.
export const list = items => html`
  <ul class="results">
    ${items.map(i => html`<li class="row" data-id="${i.id}">${i.label}</li>`)}
  </ul>`;

// None of these are markup — they must contribute nothing:
const greeting = `hello ${'world'}`;
const path = 'not ` a template';
// and a `backtick` in a comment is just noise.
