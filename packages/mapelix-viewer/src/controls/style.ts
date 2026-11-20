/**
 * Styles of the viewer controls. Colours are CSS variables on `.mx-ui`, so a host can restyle
 * them; light and dark follow the system unless `data-theme` is set.
 */
export const CONTROL_STYLE = `
.mx-ui {
  --mx-bg: rgb(22 26 32 / 0.9);
  --mx-bg-strong: rgb(18 21 26 / 0.97);
  --mx-fg: #eef1f5;
  --mx-muted: #b4bcc8;
  --mx-line: rgb(255 255 255 / 0.14);
  --mx-accent: #7fb4ff;
  --mx-pressed: #2f5d93;
  --mx-active: rgb(127 180 255 / 0.3);
  --mx-alert: #ffb4ab;
  --mx-shadow: 0 2px 8px rgb(0 0 0 / 0.45);
  position: absolute;
  inset: 0;
  z-index: 10;
  box-sizing: border-box;
  display: grid;
  grid-template: "top top top" auto "mid mid mid" minmax(0, 1fr) "left center right" auto / auto minmax(0, 1fr) auto;
  gap: 8px;
  padding: calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right))
    calc(8px + env(safe-area-inset-bottom) + var(--mx-keyboard, 0px)) calc(8px + env(safe-area-inset-left));
  pointer-events: none;
  color: var(--mx-fg);
  font: 15px/1.35 system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
}
@media (prefers-color-scheme: light) {
  .mx-ui:not([data-theme="dark"]) {
    --mx-bg: rgb(250 251 253 / 0.92);
    --mx-bg-strong: rgb(252 253 255 / 0.98);
    --mx-fg: #16202c;
    --mx-muted: #4a5666;
    --mx-line: rgb(0 0 0 / 0.14);
    --mx-accent: #1d5fb8;
    --mx-pressed: #cfe0f7;
    --mx-active: rgb(29 95 184 / 0.18);
    --mx-alert: #a3261b;
    --mx-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
  }
}
.mx-ui[data-theme="light"] {
  --mx-bg: rgb(250 251 253 / 0.92);
  --mx-bg-strong: rgb(252 253 255 / 0.98);
  --mx-fg: #16202c;
  --mx-muted: #4a5666;
  --mx-line: rgb(0 0 0 / 0.14);
  --mx-accent: #1d5fb8;
  --mx-pressed: #cfe0f7;
  --mx-active: rgb(29 95 184 / 0.18);
  --mx-alert: #a3261b;
  --mx-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
}
.mx-ui * { box-sizing: border-box; }
.mx-ui [hidden] { display: none !important; }
.mx-ui .mx-off { visibility: hidden; }
.mx-top { grid-area: top; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; min-width: 0; }
.mx-mid { grid-area: mid; position: relative; min-height: 0; }
.mx-left, .mx-right { display: grid; grid-template-columns: 48px; gap: 8px; align-content: end; }
.mx-left { grid-area: left; }
.mx-right { grid-area: right; }
.mx-ui[data-short] .mx-left, .mx-ui[data-short] .mx-right { grid-template-columns: 48px 48px; }
.mx-center { grid-area: center; display: flex; justify-content: center; align-items: flex-end; gap: 8px; min-width: 0; }
.mx-glass { background: var(--mx-bg); box-shadow: var(--mx-shadow); border-radius: 12px; pointer-events: auto; }
.mx-btn {
  flex: none; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 12px; display: grid; place-items: center;
  font: inherit; font-weight: 700; color: inherit; background: var(--mx-bg); box-shadow: var(--mx-shadow);
  cursor: pointer; pointer-events: auto; touch-action: manipulation; transition: background 120ms, transform 120ms;
}
.mx-btn:active, .mx-btn[data-held] { background: var(--mx-active); transform: scale(0.94); }
.mx-btn[aria-pressed="true"], .mx-btn[aria-expanded="true"] { background: var(--mx-pressed); }
.mx-ui :focus { outline: none; }
.mx-ui :focus-visible { outline: 3px solid var(--mx-accent); outline-offset: 2px; }
.mx-btn svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mx-readout {
  margin: 0; padding: 7px 11px; min-width: 0; max-width: min(100%, 420px); pointer-events: none;
  font-variant-numeric: tabular-nums; overflow: hidden;
}
.mx-readout > span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mx-readout .mx-scale { color: var(--mx-muted); }
.mx-readout .mx-note { white-space: normal; color: var(--mx-muted); font-size: 13px; }
.mx-readout .mx-note[data-alert] { color: var(--mx-alert); }
.mx-compass svg { transition: transform 80ms linear; }
.mx-compass .mx-north { fill: #e8604c; stroke: none; }
.mx-compass .mx-south { fill: currentColor; stroke: none; opacity: 0.5; }
.mx-progress { position: absolute; left: 0; right: 0; top: 0; height: 3px; pointer-events: none; overflow: hidden; }
.mx-progress::after { content: ""; position: absolute; inset: 0; width: 40%; background: var(--mx-accent); animation: mx-run 1.1s ease-in-out infinite; }
@keyframes mx-run { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .mx-progress::after { animation: none; width: 100%; opacity: 0.6; } .mx-btn { transition: none; } }
.mx-panel, .mx-card {
  position: absolute; display: flex; flex-direction: column; max-height: 100%; min-height: 0;
  background: var(--mx-bg-strong); box-shadow: var(--mx-shadow); border-radius: 14px; pointer-events: auto;
  overscroll-behavior: contain;
}
.mx-panel { left: 0; bottom: 0; width: min(360px, 100%); }
.mx-card { right: 0; top: 0; width: min(320px, 100%); }
.mx-ui[data-narrow] .mx-panel { width: 100%; }
.mx-ui[data-narrow] .mx-card { width: 100%; }
.mx-head { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 14px; border-bottom: 1px solid var(--mx-line); touch-action: none; }
.mx-head h2 { flex: 1; margin: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mx-head .mx-btn { box-shadow: none; background: transparent; width: 44px; height: 44px; }
.mx-grip { display: none; }
.mx-ui[data-narrow] .mx-panel .mx-grip { display: block; position: absolute; top: 5px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px; background: var(--mx-line); }
.mx-body { overflow: auto; padding: 4px 14px 14px; min-height: 0; }
.mx-body section { padding: 10px 0; border-bottom: 1px solid var(--mx-line); }
.mx-body section:last-child { border-bottom: 0; }
.mx-body h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--mx-muted); }
.mx-body p { margin: 6px 0; color: var(--mx-muted); font-size: 13px; }
.mx-body p[role="alert"] { color: var(--mx-alert); }
.mx-row { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.mx-check { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
.mx-check input { width: 22px; height: 22px; margin: 0; accent-color: var(--mx-accent); }
.mx-field { display: grid; gap: 4px; margin: 6px 0; }
.mx-field input[type="range"] { width: 100%; height: 44px; margin: 0; accent-color: var(--mx-accent); }
.mx-ui select, .mx-ui input[type="number"] {
  min-height: 44px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--mx-line);
  font: inherit; color: var(--mx-fg); background: var(--mx-bg-strong);
}
.mx-ui input[type="number"] { width: 100%; }
.mx-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 3px; border-radius: 10px; background: var(--mx-line); }
.mx-text {
  min-height: 44px; padding: 0 14px; border: 0; border-radius: 8px; font: inherit; color: inherit; background: transparent;
  cursor: pointer; touch-action: manipulation; text-align: left;
}
.mx-text:active { background: var(--mx-active); }
.mx-text[aria-pressed="true"] { background: var(--mx-pressed); }
.mx-text:disabled, .mx-check:has(input:disabled), .mx-btn:disabled { opacity: 0.5; cursor: default; }
.mx-solid { background: var(--mx-pressed); text-align: center; }
.mx-seg .mx-text { background: transparent; text-align: center; }
.mx-seg .mx-text[aria-pressed="true"] { background: var(--mx-pressed); box-shadow: var(--mx-shadow); }
.mx-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mx-list { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; }
.mx-list .mx-text { width: 100%; display: grid; padding: 6px 12px; }
.mx-list small { color: var(--mx-muted); }
.mx-menu { padding: 4px; display: grid; gap: 2px; }
.mx-menu .mx-text { min-width: 160px; }
.mx-card .mx-body p { color: var(--mx-fg); }
/* Editing a marker on a phone: the bottom buttons make room, the form keeps the upper map in view. */
.mx-ui[data-narrow][data-editing] :is(.mx-left, .mx-center, .mx-right) { display: none; }
.mx-ui[data-narrow][data-editing] .mx-panel { max-height: 50%; }
.mx-ui[data-narrow][data-editing][data-typing] .mx-panel { max-height: 100%; }
.mx-ui input[type="text"] {
  width: 100%; min-height: 44px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--mx-line);
  font: inherit; font-size: 16px; color: var(--mx-fg); background: var(--mx-bg-strong);
}
.mx-ui input[type="color"] { width: 100%; height: 44px; padding: 2px; border-radius: 8px; border: 1px solid var(--mx-line); background: var(--mx-bg-strong); }
.mx-form .mx-field > span { font-size: 13px; color: var(--mx-muted); }
.mx-form select { font-size: 16px; }
.mx-choices { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 8px; }
.mx-choice { min-width: 44px; padding: 0; text-align: center; font-size: 20px; border: 1px solid var(--mx-line); }
.mx-swatch { background: var(--mx-swatch); border-color: var(--mx-line); }
.mx-position { border: 0; padding: 0; margin: 8px 0; }
.mx-position legend { padding: 0; font-size: 13px; color: var(--mx-muted); }
.mx-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.mx-link { padding: 0 4px; color: var(--mx-accent); text-decoration: underline; }
.mx-ui .mx-error { color: var(--mx-alert); font-weight: 600; }
.mx-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 8px 0 0; }
.mx-form .mx-actions { position: sticky; bottom: -14px; margin: 0 -14px -14px; padding: 8px 14px 14px; background: var(--mx-bg-strong); border-top: 1px solid var(--mx-line); }
.mx-body:has(> .mx-form) { scroll-padding-bottom: 84px; }
.mx-danger { color: var(--mx-alert); }
.mx-danger.mx-solid, .mx-confirm + .mx-actions .mx-danger { background: var(--mx-alert); color: var(--mx-bg-strong); text-align: center; }
.mx-caves { display: flex; gap: 8px; pointer-events: none; }
`;
