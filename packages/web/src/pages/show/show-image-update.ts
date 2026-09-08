import type { EditableImageSnapshot } from "../../lib/types.js";
import type { ShowImage } from "./show-layout.js";

/** Applies only the list-owned base fields from the authoritative edit. */
export function updatedShowImage(
  current: ShowImage,
  snapshot: EditableImageSnapshot
): ShowImage {
  return {
    id: current.id,
    title: snapshot.title,
    thumb_url: snapshot.thumb_url,
    width: snapshot.width,
    height: snapshot.height
  };
}
