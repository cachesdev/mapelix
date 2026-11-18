import { error } from "@sveltejs/kit";
import { textureUploads } from "$lib/server/world";

export const load = () => {
  if (!textureUploads) error(404, "Texture packs are not managed by this server");
  return {};
};
