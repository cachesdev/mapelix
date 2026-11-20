import { screenSize, viewport } from "three/tsl";
import { REVISION } from "three/webgpu";

const retained = new WeakSet<object>();

/**
 * Three 0.186 creates a new shared uniform in ScreenNode.setup for each shader
 * rebuild. Its render-context binding cache then keeps the old uniform identities.
 * Retain each public singleton's setup result; the original ScreenNode.update
 * still refreshes its existing vector for the current framebuffer every render.
 * This preserves screen coordinates and shared-buffer efficiency across backends
 * without editing Three, replacing shaders or clearing private renderer caches.
 */
export function retainScreenUniforms(): void {
  if (REVISION !== "186") return;
  for (const node of [screenSize, viewport]) {
    if (retained.has(node)) continue;
    retained.add(node);
    const setup = node.setup.bind(node);
    let output: ReturnType<typeof setup> | undefined;
    node.setup = (builder) => (output ??= setup(builder));
  }
}
