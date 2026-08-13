export type ImportStatusSubscriptionTarget = {
  id: string;
  attemptKey?: string;
};

export class ImportStatusSubscription {
  readonly #attemptKeys: ReadonlySet<string>;
  readonly #ids = new Map<string, string>();

  constructor(attemptKeys: readonly string[]) {
    this.#attemptKeys = new Set(attemptKeys.map(canonicalImportSubscriptionKey));
  }

  observe(target: ImportStatusSubscriptionTarget) {
    const canonicalId = canonicalImportSubscriptionKey(target.id);
    const current = this.#ids.get(canonicalId);
    if (current) return current;
    if (
      !target.attemptKey
      || !this.#attemptKeys.has(canonicalImportSubscriptionKey(target.attemptKey))
    ) {
      return undefined;
    }
    this.#ids.set(canonicalId, target.id);
    return target.id;
  }
}

export function canonicalImportSubscriptionKey(value: string) {
  return value.toLowerCase();
}
