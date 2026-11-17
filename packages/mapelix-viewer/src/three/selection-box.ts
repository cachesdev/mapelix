import {
  horizontalSelection,
  SELECTION_LIMITS,
  type HorizontalSelection,
} from "@mapelix/scene-prototype/selection";
import { DIMENSIONS, type SceneContext } from "@mapelix/scene-prototype/dimensions";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Object3D,
  Vector4,
  type PerspectiveCamera,
  type Node,
} from "three/webgpu";
import { normalWorldGeometry, positionWorld, uniform } from "three/tsl";

export type SelectionTool = "off" | "move" | "resize";
export interface SelectionChange {
  readonly selection: HorizontalSelection;
  readonly minY: number;
}

/** One bounded helper and two shared uniforms per viewer, reused through all view switches. */
export class SelectionBox {
  readonly root = new Group();
  private readonly active = uniform(0);
  private readonly bounds = uniform(new Vector4());
  // Test the owning block's side of a face so a positive face exactly at maxX/Z survives.
  private readonly ownerPosition = positionWorld.sub(normalWorldGeometry.mul(0.01));
  readonly mask: Node<"bool"> = this.active
    .lessThan(0.5)
    .or(
      this.ownerPosition.x
        .greaterThanEqual(this.bounds.x)
        .and(this.ownerPosition.x.lessThan(this.bounds.y))
        .and(this.ownerPosition.z.greaterThanEqual(this.bounds.z))
        .and(this.ownerPosition.z.lessThan(this.bounds.w)),
    );
  private readonly target = new Object3D();
  private readonly frame: LineSegments;
  private readonly controls: TransformControls;
  private context: SceneContext;
  private selection: HorizontalSelection | undefined;
  private tool: SelectionTool = "off";

  constructor(
    camera: PerspectiveCamera,
    canvas: HTMLElement,
    context: SceneContext,
    private readonly onChange: (change: SelectionChange) => void,
    private readonly onDrag: (dragging: boolean) => void,
  ) {
    this.context = context;
    const cube = new BoxGeometry(1, 1, 1);
    this.frame = new LineSegments(
      new EdgesGeometry(cube),
      new LineBasicNodeMaterial({ color: 0x65dce8, depthTest: false, depthWrite: false }),
    );
    cube.dispose();
    this.frame.renderOrder = 100;
    this.target.add(this.frame);
    this.controls = new TransformControls(camera, canvas);
    this.controls.setSize(0.65);
    this.controls.setTranslationSnap(1);
    this.controls.setScaleSnap(1);
    this.controls.addEventListener("dragging-changed", (event) => onDrag(Boolean(event.value)));
    this.controls.addEventListener("objectChange", () => this.preview());
    this.controls.addEventListener("mouseUp", () => this.commit());
    this.root.add(this.target, this.controls.getHelper());
    this.set(undefined, context);
  }

  set(selection: HorizontalSelection | undefined, context = this.context): void {
    this.selection = selection;
    this.context = context;
    const enabled = selection !== undefined && context.mode === "caves";
    this.active.value = enabled ? 1 : 0;
    this.target.visible = enabled;
    if (enabled) {
      this.target.position.set(
        (selection.minX + selection.maxX) / 2,
        (context.minY + context.maxY) / 2,
        (selection.minZ + selection.maxZ) / 2,
      );
      this.target.scale.set(
        selection.maxX - selection.minX,
        context.maxY - context.minY,
        selection.maxZ - selection.minZ,
      );
      this.bounds.value.set(selection.minX, selection.maxX, selection.minZ, selection.maxZ);
    }
    this.setTool(this.tool);
  }

  setTool(tool: SelectionTool): void {
    this.tool = tool;
    this.controls.dragging = false;
    this.controls.axis = null;
    this.controls.detach();
    this.controls.enabled =
      this.selection !== undefined && this.context.mode === "caves" && tool !== "off";
    if (!this.controls.enabled) {
      this.onDrag(false);
      return;
    }
    this.controls.setMode(tool === "resize" ? "scale" : "translate");
    this.controls.showY = tool === "move";
    this.controls.showXY = false;
    this.controls.showYZ = false;
    this.controls.attach(this.target);
  }

  private normalized(): SelectionChange {
    const width = Math.round(
      Math.min(
        SELECTION_LIMITS.maxSize,
        Math.max(SELECTION_LIMITS.minSize, Math.abs(this.target.scale.x)),
      ),
    );
    const depth = Math.round(
      Math.min(
        SELECTION_LIMITS.maxSize,
        Math.max(SELECTION_LIMITS.minSize, Math.abs(this.target.scale.z)),
      ),
    );
    const minX = Math.round(this.target.position.x - width / 2),
      minZ = Math.round(this.target.position.z - depth / 2);
    const height = this.context.maxY - this.context.minY;
    const config = DIMENSIONS[this.context.dimension];
    const minY = Math.max(
      config.minY,
      Math.min(config.maxY - height, Math.round((this.target.position.y - height / 2) / 16) * 16),
    );
    return {
      selection: horizontalSelection({ minX, maxX: minX + width, minZ, maxZ: minZ + depth }),
      minY,
    };
  }

  private preview(): void {
    try {
      const { selection: s } = this.normalized();
      this.bounds.value.set(s.minX, s.maxX, s.minZ, s.maxZ);
    } catch {
      /* Keep the last valid clip while dragging at world bounds. */
    }
  }

  private commit(): void {
    try {
      const result = this.normalized();
      this.set(result.selection);
      this.onChange(result);
    } catch {
      this.set(this.selection);
    }
  }

  dispose(): void {
    this.onDrag(false);
    this.controls.dispose();
    this.frame.geometry.dispose();
    (this.frame.material as LineBasicNodeMaterial).dispose();
    this.root.clear();
  }
}
