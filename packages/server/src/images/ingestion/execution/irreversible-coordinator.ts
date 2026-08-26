import {
  ingestionSessionPairKey as pairKey,
  type IngestionSessionPair
} from "../sessions/model.ts";

type IrreversibleState = "cancellable" | "database_started";

type IrreversibleRecord = {
  state: IrreversibleState;
  settled: Promise<unknown> | null;
};

/**
 * Serializes only the in-process boundary where a commit stops being
 * cancellable. Redis and PostgreSQL remain the respective truth sources; this
 * coordinator deliberately contains no recovery or durable queue state.
 */
export class IngestionIrreversibleCoordinator {
  readonly #records = new Map<string, IrreversibleRecord>();
  readonly #tails = new Map<string, Promise<void>>();

  async #critical<T>(pair: IngestionSessionPair, work: () => Promise<T>) {
    const key = pairKey(pair);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        void tail.then(() => {
          if (this.#tails.get(key) === tail) this.#tails.delete(key);
        });
      }
    }
  }

  registerCancellable(pair: IngestionSessionPair) {
    const key = pairKey(pair);
    if (this.#records.has(key)) return false;
    this.#records.set(key, { state: "cancellable", settled: null });
    return true;
  }

  unregisterCancellable(pair: IngestionSessionPair) {
    const key = pairKey(pair);
    const record = this.#records.get(key);
    if (record?.state === "cancellable") this.#records.delete(key);
  }

  beginDatabaseTransaction<T>(
    pair: IngestionSessionPair,
    verify: () => Promise<void>,
    start: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    return this.#critical(pair, async () => {
      const key = pairKey(pair);
      const record = this.#records.get(key);
      if (!record || record.state !== "cancellable") {
        throw new Error("Import commit is no longer cancellable at transaction start");
      }
      await verify();
      // verify() settles through a Promise reaction. A pause/stop can enqueue
      // an abort between its final caller-side check and this continuation, so
      // the coordinator owns the last synchronous check at the state boundary.
      signal?.throwIfAborted();
      record.state = "database_started";
      // Calling the function inside this critical section starts the database
      // transaction in the same boundary as the state transition.
      let transaction: Promise<T>;
      try {
        transaction = start();
      } catch (error) {
        record.state = "cancellable";
        throw error;
      }
      record.settled = transaction;
      void transaction.finally(() => {
        if (this.#records.get(key) === record) this.#records.delete(key);
      }).catch(() => undefined);
      return { transaction };
    }).then(({ transaction }) => transaction);
  }

  cancelBoundary<T>(
    pair: IngestionSessionPair,
    discard: () => Promise<T>
  ): Promise<
    | { status: "discarded"; value: T }
    | { status: "resolving"; settled: Promise<unknown> }
  > {
    return this.#critical(pair, async () => {
      const key = pairKey(pair);
      const record = this.#records.get(key);
      if (record?.state === "database_started") {
        return {
          status: "resolving" as const,
          settled: record.settled ?? Promise.resolve()
        };
      }
      const value = await discard();
      if (record?.state === "cancellable" && this.#records.get(key) === record) {
        this.#records.delete(key);
      }
      return {
        status: "discarded" as const,
        value
      };
    });
  }

  state(pair: IngestionSessionPair) {
    return this.#records.get(pairKey(pair))?.state ?? null;
  }

  settled(pair: IngestionSessionPair) {
    return this.#records.get(pairKey(pair))?.settled ?? null;
  }

  async waitForDatabaseTransactions() {
    for (;;) {
      const transactions = [...this.#records.values()].flatMap((record) => (
        record.state === "database_started" && record.settled
          ? [record.settled]
          : []
      ));
      if (!transactions.length) return;
      await Promise.allSettled(transactions);
    }
  }
}
