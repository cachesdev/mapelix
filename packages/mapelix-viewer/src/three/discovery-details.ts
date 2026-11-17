import type { DiscoveryGroup } from "@mapelix/scene-prototype/discoveries";
import { defaultDiscoveryDetails, type DiscoveryDetailText } from "./discovery-focus";

/** A single owned card; text is supplied through textContent, never host HTML. */
export class DiscoveryDetails {
  private readonly root = document.createElement("section");
  private layoutKey = "";
  constructor(
    container: HTMLElement,
    private readonly dismiss: () => void,
    private readonly format: (
      group: DiscoveryGroup,
    ) => DiscoveryDetailText = defaultDiscoveryDetails,
    private readonly enabled = true,
  ) {
    this.root.setAttribute("aria-label", "Selected discovery");
    this.root.setAttribute("data-discovery-details", "");
    this.root.setAttribute("aria-live", "polite");
    Object.assign(this.root.style, {
      position: "fixed",
      boxSizing: "border-box",
      width: "280px",
      maxWidth: "calc(100vw - 24px)",
      padding: "12px",
      border: "1px solid #586473",
      borderRadius: "10px",
      color: "#f1f5fa",
      background: "#101c2bed",
      zIndex: "110",
      pointerEvents: "auto",
      font: "13px system-ui",
    });
    this.root.hidden = true;
    container.append(this.root);
  }
  show(group: DiscoveryGroup | undefined): void {
    this.layoutKey = "";
    this.root.replaceChildren();
    this.root.hidden = !group || !this.enabled;
    if (!group || !this.enabled) return;
    const text = this.format(group),
      title = document.createElement("strong"),
      close = document.createElement("button");
    title.textContent = text.title;
    this.root.setAttribute("aria-label", text.title);
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", text.closeLabel ?? "Close discovery details");
    Object.assign(close.style, {
      float: "right",
      minWidth: "44px",
      minHeight: "44px",
      cursor: "pointer",
      background: "#1b2532",
      color: "inherit",
      border: "1px solid #586473",
      borderRadius: "6px",
      fontSize: "18px",
    });
    close.onclick = this.dismiss;
    this.root.append(close, title);
    for (const line of text.lines) {
      const p = document.createElement("p");
      p.textContent = line;
      this.root.append(p);
    }
  }
  update(canvas: HTMLElement): void {
    if (this.root.hidden) return;
    const bounds = canvas.getBoundingClientRect();
    const key = `${bounds.left}/${bounds.top}/${bounds.width}/${bounds.height}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.root.style.maxWidth = `${Math.max(0, bounds.width - 24)}px`;
    this.root.style.left = `${bounds.left + 12}px`;
    this.root.style.top = `${Math.max(bounds.top + 12, Math.min(bounds.top + 90, bounds.bottom - this.root.offsetHeight - 12))}px`;
  }
  dispose(): void {
    this.root.remove();
  }
}
