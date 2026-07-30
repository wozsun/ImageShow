import type { ReorderDirection } from "./reorder.js";

type ReorderControlTargets = Partial<
  Record<ReorderDirection, HTMLButtonElement>
>;

/**
 * Owns reorder control DOM refs by stable slug and exact direction. Page
 * coordination remains in the React hook; this registry only binds and
 * focuses already-mounted controls.
 */
export class ReorderControlRegistry {
  readonly #targets = new Map<string, ReorderControlTargets>();

  register(
    slug: string,
    direction: ReorderDirection,
    node: HTMLButtonElement | null
  ) {
    const targets = this.#targets.get(slug) ?? {};
    if (node) {
      targets[direction] = node;
      this.#targets.set(slug, targets);
      return;
    }

    delete targets[direction];
    if (targets.previous || targets.next) {
      this.#targets.set(slug, targets);
    } else {
      this.#targets.delete(slug);
    }
  }

  focus(slug: string, direction: ReorderDirection) {
    const target = this.#targets.get(slug)?.[direction];
    if (!target) return false;
    target.focus();
    return true;
  }
}
