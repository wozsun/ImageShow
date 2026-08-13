import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ImportJob } from "../../../lib/types.js";
import {
  advanceImportStatusGeneration,
  importStatusGenerationSubscriptions,
  type ImportStatusGeneration,
  type ImportStatusSubscriptionSpec
} from "./import-status-subscription.js";
import { startImportStatusSubscription } from "./import-status-transport.js";

function importStatusSubscriptionSignature(spec: ImportStatusSubscriptionSpec) {
  return `${spec.jobIds.join(",")}|${spec.attemptKeys.join(",")}`;
}

type ActiveImportStatusSubscription = {
  signature: string;
  stop: () => void;
};

export function useImportStatusEvents(
  enabled: boolean,
  jobs: ImportJob[],
  jobsRef: RefObject<ImportJob[]>,
  updateJob: (id: string, patch: Partial<ImportJob>) => void
) {
  const [generation, setGeneration] = useState<ImportStatusGeneration>(
    () => new Map()
  );
  const activeSubscriptions = useRef(
    new Map<string, ActiveImportStatusSubscription>()
  );

  useEffect(() => {
    setGeneration((currentGeneration) => (
      enabled
        ? advanceImportStatusGeneration(currentGeneration, jobs)
        : currentGeneration.size === 0 ? currentGeneration : new Map()
    ));
  }, [enabled, jobs]);

  const subscriptions = useMemo(
    () => importStatusGenerationSubscriptions(generation),
    [generation]
  );

  useEffect(() => {
    const desired = new Map(
      enabled ? subscriptions.map((spec) => [spec.key, spec]) : []
    );
    for (const [key, active] of activeSubscriptions.current) {
      const spec = desired.get(key);
      if (
        !spec
        || active.signature !== importStatusSubscriptionSignature(spec)
      ) {
        active.stop();
        activeSubscriptions.current.delete(key);
      }
    }
    for (const [key, spec] of desired) {
      if (activeSubscriptions.current.has(key)) continue;
      activeSubscriptions.current.set(key, {
        signature: importStatusSubscriptionSignature(spec),
        stop: startImportStatusSubscription(spec, jobsRef, updateJob)
      });
    }
  }, [enabled, jobsRef, subscriptions, updateJob]);

  useEffect(() => {
    const subscriptions = activeSubscriptions.current;
    return () => {
      for (const active of subscriptions.values()) active.stop();
      subscriptions.clear();
    };
  }, []);
}
