// Sample TS with embedded HTML — type annotations around the templates.
interface Banner {
  kind: 'info' | 'warning';
  message: string;
}

export function renderBanner(b: Banner): string {
  return `
    <aside class="banner ${b.kind}" role="status">
      <strong class="banner-kind">${b.kind}</strong>
      <span class="banner-text">${b.message}</span>
      <button class="dismiss" aria-label="Dismiss">&times;</button>
    </aside>`;
}

export const spinner: string = `<div class="spinner" aria-busy="true"></div>`;
