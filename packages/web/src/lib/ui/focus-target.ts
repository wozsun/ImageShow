/**
 * WebKit may move focus to the document root while the virtual keyboard is
 * being dismissed. That is a focus fallback, not proof of a new interaction
 * outside the current transient surface.
 */
export function isDocumentFallbackFocusTarget(
  ownerDocument: Document,
  target: EventTarget | null
) {
  return target === ownerDocument
    || target === ownerDocument.body
    || target === ownerDocument.documentElement;
}
