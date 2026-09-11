export function topDialogFrame(ownerDocument: Document) {
  const frames = ownerDocument.querySelectorAll<HTMLElement>("[data-dialog-frame]");
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame?.isConnected && frame.getAttribute("aria-hidden") !== "true" && !frame.inert) return frame;
  }
  return null;
}
