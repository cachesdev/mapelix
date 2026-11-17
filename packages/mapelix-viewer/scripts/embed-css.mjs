// Writes the bundle's styles as dist-embed/mapelix-viewer.css, for hosts whose content policy
// forbids inline styles. Run after `tsc` and the embed build.
import { writeFile } from "node:fs/promises";
import { CONTROL_STYLE } from "../dist/controls/style.js";
import { MARKER_STYLE } from "../dist/markers/style.js";

const header = "/* Mapelix viewer styles: controls, marker editor and markers. */\n";
await writeFile(
  new URL("../dist-embed/mapelix-viewer.css", import.meta.url),
  `${header}${CONTROL_STYLE.trim()}\n${MARKER_STYLE.trim()}\n`,
);
