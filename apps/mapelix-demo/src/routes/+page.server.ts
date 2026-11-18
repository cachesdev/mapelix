import { hasWorld, textureUploads } from "$lib/server/world";

export const load = () => ({ world: hasWorld, texturePacks: hasWorld && textureUploads });
