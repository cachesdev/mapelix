/**
 * Styles of the marker layer. Items are placed with transforms only; nothing in the layer takes
 * pointer events, so gestures always reach the map or the 3D view.
 */
export const MARKER_STYLE = `
.mx-markers {
  --mx-marker-default: #e8604c;
  --mx-marker-ring: #ffffff;
  --mx-marker-label-bg: rgb(18 21 26 / 0.88);
  --mx-marker-label-fg: #eef1f5;
  --mx-marker-focus: #7fb4ff;
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  contain: strict;
  z-index: 5;
}
@media (prefers-color-scheme: light) {
  .mx-markers {
    --mx-marker-label-bg: rgb(252 253 255 / 0.94);
    --mx-marker-label-fg: #16202c;
    --mx-marker-focus: #1d5fb8;
  }
}
.mx-marker {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  background: none;
  pointer-events: none;
  will-change: transform;
  font: 600 13px/1 system-ui, sans-serif;
  color: #fff;
}
.mx-marker:focus { outline: none; }
.mx-marker-icon {
  position: absolute;
  left: -14px;
  top: -14px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--mx-marker, var(--mx-marker-default));
  box-shadow: 0 0 0 2px var(--mx-marker-ring), 0 2px 6px rgb(0 0 0 / 0.45);
  font-size: 15px;
  line-height: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.5);
}
.mx-marker-icon img { width: 100%; height: 100%; object-fit: cover; }
.mx-marker[data-kind="cluster"] .mx-marker-icon {
  left: -16px;
  top: -16px;
  width: 32px;
  height: 32px;
  font-size: 13px;
  background: var(--mx-marker, #3b4656);
  box-shadow: 0 0 0 2px var(--mx-marker-ring), 0 0 0 5px rgb(255 255 255 / 0.35), 0 2px 6px rgb(0 0 0 / 0.45);
}
.mx-marker[aria-current] .mx-marker-icon {
  box-shadow: 0 0 0 3px var(--mx-marker-focus), 0 0 0 5px var(--mx-marker-ring), 0 2px 8px rgb(0 0 0 / 0.5);
}
.mx-marker:focus-visible .mx-marker-icon { outline: 3px solid var(--mx-marker-focus); outline-offset: 3px; }
.mx-marker-label {
  position: absolute;
  left: 0;
  top: 0;
  height: 22px;
  max-width: 200px;
  box-sizing: border-box;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--mx-marker-label-bg);
  color: var(--mx-marker-label-fg);
  font: 600 13px/22px system-ui, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
}
`;
