import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { logger } from "../../../core/logger.ts";
import type {
  IngestionQueueMetadata,
  IngestionQueueType,
  StoredIngestionSession
} from "./model.ts";

export type IngestionQueueMutation = Readonly<{
  owner: string;
  queue: IngestionQueueType;
  kind: "semantic" | "progress" | "removed";
  metadata: IngestionQueueMetadata;
  session?: StoredIngestionSession;
  completedItem?: AdminImageListItemDto;
}>;

export type IngestionQueueListener = (
  event: IngestionQueueMutation
) => void | Promise<void>;

export class IngestionQueueListenerHub {
  readonly #listeners = new Map<string, Set<IngestionQueueListener>>();

  #scope(owner: string, queue: IngestionQueueType) {
    return `${owner}\0${queue}`;
  }

  subscribe(
    owner: string,
    queue: IngestionQueueType,
    listener: IngestionQueueListener
  ) {
    const scope = this.#scope(owner, queue);
    const listeners = this.#listeners.getOrInsertComputed(
      scope,
      () => new Set()
    );
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(scope);
    };
  }

  publish(event: IngestionQueueMutation) {
    for (const listener of [...(this.#listeners.get(
      this.#scope(event.owner, event.queue)
    ) ?? [])]) {
      try {
        void Promise.resolve(listener(event)).catch((error: unknown) => {
          logger.error("ingestion_queue_listener_failed", error);
        });
      } catch (error) {
        logger.error("ingestion_queue_listener_failed", error);
      }
    }
  }
}
