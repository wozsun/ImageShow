import type { IngestionSessionPairDto } from "@imageshow/shared/browser";
import type { IngestionJob } from "./ingestion-job.js";

type DetachedProvisionalHandoff = Readonly<{
  connectionGeneration: number;
  job: IngestionJob;
}>;

type HandoffRetryGate = Readonly<{
  connectionGeneration: number;
  revision: number;
  mode: "state-change" | "coverage";
}>;

export type ServerQueueConnectionSnapshot = Readonly<{
  status: "idle" | "connecting" | "loading" | "ready" | "disconnected" | "error";
  connectionGeneration: number;
  revision: number | null;
  lastAcceptedOrder: number | null;
}>;

type HandoffState = {
  job: IngestionJob;
  detached: DetachedProvisionalHandoff;
  retry: HandoffRetryGate;
  completed: true;
  receipt: IngestionSessionPairDto;
};
type HandoffField = keyof HandoffState;

/** One exact-pair owner; partial transitions retain the other pending duties. */
export class IngestionHandoffs {
  #pairs = new Map<string, Partial<HandoffState>>();

  get<K extends HandoffField>(field: K, pair: string): HandoffState[K] | undefined {
    return this.#pairs.get(pair)?.[field];
  }

  has(field: HandoffField, pair: string) {
    return this.get(field, pair) !== undefined;
  }

  set<K extends HandoffField>(field: K, pair: string, value: HandoffState[K]) {
    let state = this.#pairs.get(pair);
    if (!state) {
      state = {};
      this.#pairs.set(pair, state);
    }
    state[field] = value;
  }

  delete(field: HandoffField, pair: string) {
    const state = this.#pairs.get(pair);
    if (!state || state[field] === undefined) return false;
    delete state[field];
    if (!Object.keys(state).length) this.#pairs.delete(pair);
    return true;
  }

  retire(pair: string) {
    this.#pairs.delete(pair);
  }

  finishStatusRead(pair: string) {
    // Completion receipts are consumed by the shared completion observer.
    const receipt = this.get("receipt", pair);
    this.retire(pair);
    if (receipt) this.set("receipt", pair, receipt);
  }

  *entries<K extends HandoffField>(field: K): IterableIterator<[string, HandoffState[K]]> {
    for (const [pair, state] of this.#pairs) {
      const value = state[field];
      if (value !== undefined) yield [pair, value];
    }
  }

  *values<K extends HandoffField>(field: K): IterableIterator<HandoffState[K]> {
    for (const [, value] of this.entries(field)) yield value;
  }

  *keys(field: HandoffField) {
    for (const [pair] of this.entries(field)) yield pair;
  }

  hasPending(field: HandoffField) {
    return !this.entries(field).next().done;
  }

  clear() {
    this.#pairs.clear();
  }
}
