/**
 * Allows only the latest asynchronous intent to commit state while its owner
 * is mounted. Mount state is separate from the sequence so React Strict Mode's
 * effect replay does not discard an intent already accepted by the component.
 */
export class AsyncIntentFence {
  private currentSequence = 0;
  private mounted = true;

  mount() {
    this.mounted = true;
  }

  unmount() {
    this.mounted = false;
  }

  begin() {
    return ++this.currentSequence;
  }

  invalidate() {
    this.currentSequence += 1;
  }

  isCurrent(sequence: number) {
    return this.mounted && sequence === this.currentSequence;
  }

  isMounted() {
    return this.mounted;
  }
}
