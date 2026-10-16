// Credits module, client side: the credit line along the bottom plus a Credits button that opens an overlay listing every
// source the area used, with its licence. Knows nothing about the game or the map: give it the credit lines.
import './credits.css';
import { describeCredits } from './sources.js';

export { SOURCES, describeCredits } from './sources.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));

/** HTML for the overlay body. Pure and escaped, so it can be tested without a DOM. */
export function creditsHtml(entries) {
  if (!entries.length) return '<p class="credits-none">No sources are listed for this area.</p>';
  let role = null, html = '';
  for (const e of entries) {
    if (e.role !== role) { role = e.role; html += `<h3>${esc(role)}</h3>`; }
    html += `<div class="credits-entry"><div class="credits-name">${link(e.url, e.name)}</div>`
      + (e.licence ? `<div class="credits-licence">${link(e.licenceUrl, e.licence)}</div>` : '')
      + (e.name !== e.line ? `<div class="credits-line">${esc(e.line)}</div>` : '')
      + (e.note ? `<div class="credits-note">${esc(e.note)}</div>` : '') + '</div>';
  }
  return html;
}

/**
 * @param {HTMLElement} host   the footer element: gets the credit line and a Credits button
 * @param {string[]} lines     credit lines, e.g. map.attribution
 * @param {Document} [doc]
 * @returns {{ open(), close(), destroy() }}
 */
export function mountCredits(host, lines, doc = globalThis.document) {
  const entries = describeCredits(lines);
  host.innerHTML = `<span class="credits-text">${esc((lines ?? []).join(' · '))}</span> <button type="button" class="credits-btn">Credits</button>`;
  const overlay = doc.createElement('div');
  overlay.className = 'credits-overlay'; overlay.hidden = true;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Credits');
  overlay.innerHTML = `<div class="credits-card"><button type="button" class="credits-close" aria-label="Close">×</button><h2>Credits</h2>${creditsHtml(entries)}</div>`;
  doc.body.appendChild(overlay);

  const open = () => { overlay.hidden = false; overlay.querySelector('.credits-close').focus?.(); };
  const close = () => { overlay.hidden = true; host.querySelector('.credits-btn').focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); };
  host.querySelector('.credits-btn').addEventListener('click', open);
  overlay.querySelector('.credits-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });   // the backdrop, not the card
  doc.addEventListener('keydown', onKey);
  return { open, close, destroy() { doc.removeEventListener('keydown', onKey); overlay.remove(); } };
}
