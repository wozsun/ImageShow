import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportDuplicateDetailsResultDto } from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";
import { importDuplicateMessage } from "./duplicate-match.js";
import { getImportDuplicateDetails } from "./import-api.js";

const invalidationListeners = new Set<(md5: string) => void>();

type DuplicateDetailsItem = ImportDuplicateDetailsResultDto["items"][number];

type DuplicateDetailsQuery = Readonly<{
  revision: number;
  md5s: readonly string[];
}>;

type DuplicateDetailsCache = Readonly<{
  revision: number;
  items: Map<string, DuplicateDetailsItem>;
}>;

function selectCachedDuplicateDetails(
  cache: DuplicateDetailsCache,
  md5s: readonly string[]
): ImportDuplicateDetailsResultDto {
  return {
    items: md5s.flatMap((md5) => {
      const item = cache.items.get(md5);
      return item ? [item] : [];
    })
  };
}

function sameMd5s(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((md5, index) => md5 === right[index]);
}

export function invalidateImportDuplicateDetails(md5: string) {
  for (const listener of invalidationListeners) listener(md5);
}

export function useImportDuplicateDetails({
  jobs,
  updateJobs,
  updateDuplicateDecision
}: {
  jobs: readonly ImportJob[];
  updateJobs: (patches: ReadonlyMap<string, Partial<ImportJob>>) => void;
  updateDuplicateDecision: (
    id: string,
    decision: "upload" | "confirmed"
  ) => Promise<boolean>;
}) {
  const pendingDecisionRef = useRef(new Set<string>());
  const md5s = useMemo(() => [...new Set(jobs.flatMap((job) => (
    job.status === "ready"
      && job.duplicateDecision === "undecided"
      && (job.duplicateCount ?? 0) > 0
      && job.md5
      ? [job.md5]
      : []
  )))].sort(), [jobs]);
  const md5Key = md5s.join("\0");
  const md5SetRef = useRef(new Set(md5s));
  md5SetRef.current = new Set(md5s);
  const [invalidationRevision, setInvalidationRevision] = useState(0);
  const [data, setData] = useState<ImportDuplicateDetailsResultDto | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setInvalidationRevision((current) => current + 1);
  }, []);
  const mountedRef = useRef(false);
  const currentQueryRef = useRef<DuplicateDetailsQuery | null>(null);
  const activeRequestRef = useRef<DuplicateDetailsQuery | null>(null);
  const trailingRequestRef = useRef<DuplicateDetailsQuery | null>(null);
  const requestLoopRef = useRef<Promise<void> | null>(null);
  const cacheRef = useRef<DuplicateDetailsCache | null>(null);
  const startRequestLoopRef = useRef<() => void>(() => undefined);

  const publishCachedDetails = (query: DuplicateDetailsQuery) => {
    const cache = cacheRef.current;
    if (cache?.revision !== query.revision) {
      setData(null);
      return;
    }
    const result = selectCachedDuplicateDetails(cache, query.md5s);
    setData(result.items.length ? result : null);
  };

  const queueMissingDetails = (query: DuplicateDetailsQuery) => {
    const cache = cacheRef.current;
    const activeRequest = activeRequestRef.current;
    const activeMd5s = activeRequest?.revision === query.revision
      ? new Set(activeRequest.md5s)
      : null;
    const missingMd5s = query.md5s.filter((md5) => (
      !(cache?.revision === query.revision && cache.items.has(md5))
      && !activeMd5s?.has(md5)
    ));
    if (!missingMd5s.length) {
      trailingRequestRef.current = null;
      return;
    }
    const trailingRequest = trailingRequestRef.current;
    if (
      trailingRequest?.revision === query.revision
      && sameMd5s(trailingRequest.md5s, missingMd5s)
    ) return;
    trailingRequestRef.current = {
      revision: query.revision,
      md5s: missingMd5s
    };
  };

  startRequestLoopRef.current = () => {
    if (!mountedRef.current || requestLoopRef.current) return;
    const requestLoop = (async () => {
      while (mountedRef.current) {
        const request = trailingRequestRef.current;
        trailingRequestRef.current = null;
        if (!request) return;
        activeRequestRef.current = request;
        try {
          const result = await getImportDuplicateDetails([...request.md5s]);
          const currentQuery = currentQueryRef.current;
          if (
            mountedRef.current
            && currentQuery?.revision === request.revision
          ) {
            let cache = cacheRef.current;
            if (cache?.revision !== request.revision) {
              cache = {
                revision: request.revision,
                items: new Map()
              };
              cacheRef.current = cache;
            }
            const requestedMd5s = new Set(request.md5s);
            for (const item of result.items) {
              if (requestedMd5s.has(item.md5)) cache.items.set(item.md5, item);
            }
            publishCachedDetails(currentQuery);
            if (currentQuery.md5s.every((md5) => cache.items.has(md5))) {
              setError("");
            }
          }
        } catch (reason: unknown) {
          const currentQuery = currentQueryRef.current;
          if (
            mountedRef.current
            && currentQuery?.revision === request.revision
            && request.md5s.some((md5) => currentQuery.md5s.includes(md5))
          ) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        } finally {
          if (activeRequestRef.current === request) {
            activeRequestRef.current = null;
          }
        }
      }
    })();
    requestLoopRef.current = requestLoop;
    void requestLoop.finally(() => {
      if (requestLoopRef.current === requestLoop) {
        requestLoopRef.current = null;
      }
      if (trailingRequestRef.current) startRequestLoopRef.current();
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      currentQueryRef.current = null;
      trailingRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const invalidate = (md5: string) => {
      if (
        md5SetRef.current.has(md5)
        || cacheRef.current?.items.has(md5)
        || activeRequestRef.current?.md5s.includes(md5)
        || trailingRequestRef.current?.md5s.includes(md5)
      ) {
        setInvalidationRevision((current) => current + 1);
      }
    };
    invalidationListeners.add(invalidate);
    return () => {
      invalidationListeners.delete(invalidate);
    };
  }, []);

  useEffect(() => {
    if (!md5s.length) {
      currentQueryRef.current = null;
      trailingRequestRef.current = null;
      cacheRef.current = null;
      setData(null);
      setError("");
      return;
    }
    const query = {
      revision: invalidationRevision,
      md5s
    };
    currentQueryRef.current = query;
    if (cacheRef.current?.revision !== invalidationRevision) {
      cacheRef.current = {
        revision: invalidationRevision,
        items: new Map()
      };
    }
    publishCachedDetails(query);
    queueMissingDetails(query);
    setError("");
    startRequestLoopRef.current();
  }, [invalidationRevision, md5Key]);

  useEffect(() => {
    if (!data) return;
    const snapshots = new Map(data.items.map((item) => [item.md5, item]));
    const patches = new Map<string, Partial<ImportJob>>();
    const decisions: Array<{ id: string; key: string }> = [];
    for (const job of jobs) {
      if (
        job.status !== "ready"
        || job.duplicateDecision !== "undecided"
        || !job.md5
      ) continue;
      const snapshot = snapshots.get(job.md5);
      if (!snapshot) continue;
      patches.set(job.id, snapshot.match_count > 0 ? {
        duplicates: snapshot.duplicates,
        duplicateCount: snapshot.match_count,
        message: importDuplicateMessage(snapshot.match_count)
      } : {
        // Keep the last actionable duplicate state until the Server decision
        // CAS succeeds. Clearing count first would hide both confirm/cancel
        // controls and leave an undecided card with no reachable recovery.
        message: "图库中的重复图片已不存在，正在恢复可提交状态"
      });
      if (snapshot.match_count === 0 && job.serverVersion) {
        const key = `${job.id}\0${job.serverVersion}`;
        if (!pendingDecisionRef.current.has(key)) {
          pendingDecisionRef.current.add(key);
          decisions.push({ id: job.id, key });
        }
      }
    }
    if (patches.size) updateJobs(patches);
    for (const decision of decisions) {
      void updateDuplicateDecision(decision.id, "upload").then(
        (succeeded) => {
          pendingDecisionRef.current.delete(decision.key);
          if (!succeeded) {
            setError("重复状态恢复失败，请重试");
          }
        },
        (reason: unknown) => {
          pendingDecisionRef.current.delete(decision.key);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      );
    }
  }, [data, jobs, updateDuplicateDecision, updateJobs]);

  return { error, refresh };
}
