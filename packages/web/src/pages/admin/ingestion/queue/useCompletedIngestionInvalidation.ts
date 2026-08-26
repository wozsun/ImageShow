import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { invalidateImageDataAfterIngestion } from "../../../../lib/api/query-invalidation.js";
import { invalidateIngestionDuplicateDetails } from "./useIngestionDuplicateDetails.js";
import {
  type CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import { serverIngestionPairKey } from "./model/server-ingestion-job.js";

/**
 * Owns completed-pair deduplication and the serialized image-query invalidation
 * queue. The queue is deliberately independent from the SSE owner: callers
 * only publish observations and tell it when commit/resolution work is idle.
 */
export function useCompletedIngestionInvalidation() {
  const queryClient = useQueryClient();
  const observedPairsRef = useRef(new Set<string>());
  const pendingItemsRef = useRef(
    new Map<string, CompletedIngestionObservation>()
  );
  const activeInvalidationRef = useRef<Promise<void> | null>(null);
  const invalidationRequestedRef = useRef(false);
  const invalidationScheduledRef = useRef(false);
  const queueIdleRef = useRef(false);

  const flush = useCallback(() => {
    if (!pendingItemsRef.current.size) {
      return activeInvalidationRef.current ?? Promise.resolve();
    }
    invalidationRequestedRef.current = true;
    const active = activeInvalidationRef.current;
    if (active) return active;
    const run = async () => {
      while (invalidationRequestedRef.current) {
        invalidationRequestedRef.current = false;
        const pending = [...pendingItemsRef.current.entries()];
        if (!pending.length) continue;
        const completedTimes = pending.map(([, entry]) => entry.completedAt);
        const completedAt = completedTimes.every(
          (value): value is number => value !== undefined
        )
          ? Math.max(...completedTimes)
          : undefined;
        await invalidateImageDataAfterIngestion(
          queryClient,
          pending.map(([, entry]) => entry.item),
          { completedAt }
        );
        for (const [pairKey, entry] of pending) {
          if (pendingItemsRef.current.get(pairKey) === entry) {
            pendingItemsRef.current.delete(pairKey);
          }
        }
      }
    };
    const promise = run().finally(() => {
      if (activeInvalidationRef.current === promise) {
        activeInvalidationRef.current = null;
      }
      if (
        invalidationRequestedRef.current
        && pendingItemsRef.current.size
      ) {
        void flush().catch(() => undefined);
      }
    });
    activeInvalidationRef.current = promise;
    return promise;
  }, [queryClient]);

  const schedule = useCallback(() => {
    if (invalidationScheduledRef.current) return;
    invalidationScheduledRef.current = true;
    queueMicrotask(() => {
      invalidationScheduledRef.current = false;
      if (!queueIdleRef.current) return;
      void flush().catch(() => undefined);
    });
  }, [flush]);

  const observe = useCallback((
    entries: readonly CompletedIngestionObservation[]
  ) => {
    const items: AdminImageListItemDto[] = [];
    for (const entry of entries) {
      const pairKey = serverIngestionPairKey(entry.pair);
      if (observedPairsRef.current.has(pairKey)) continue;
      observedPairsRef.current.add(pairKey);
      pendingItemsRef.current.set(pairKey, entry);
      items.push(entry.item);
    }
    if (!items.length) return;
    for (const md5 of new Set(items.map((item) => item.md5))) {
      invalidateIngestionDuplicateDetails(md5);
    }
    schedule();
  }, [schedule]);

  const setQueueIdle = useCallback((idle: boolean) => {
    queueIdleRef.current = idle;
  }, []);
  const isQueueIdle = useCallback(() => queueIdleRef.current, []);

  return { flush, isQueueIdle, observe, schedule, setQueueIdle };
}
