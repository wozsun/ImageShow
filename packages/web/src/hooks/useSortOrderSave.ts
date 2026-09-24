import { useEffect, useRef, useState } from "react";
import type { SortOrderUpdateInputDto } from "@imageshow/shared/browser";
import { api } from "../lib/api/client.js";

/** Saves one numeric value, then lets the query owner publish the server order. */
export function useSortOrderSave({
  basePath,
  externalBusy,
  refresh,
  readValue,
  reportError
}: {
  basePath: string;
  externalBusy: boolean;
  refresh: () => Promise<unknown>;
  readValue: (slug: string) => number | undefined;
  reportError: (stage: "save" | "refresh", error: unknown) => void;
}) {
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Set<string>());
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = async (slug: string, value: number) => {
    const path = `${basePath}/${slug}/sort-order`;
    if (externalBusy || pendingRef.current.has(path)) throw new Error("有操作正在进行，请稍后重试");
    pendingRef.current.add(path);
    setPendingPaths(new Set(pendingRef.current));
    // Keep each write and its authoritative read together while other rows stay editable.
    const request = queueRef.current.then(async () => {
      try {
        try {
          const body = { sort_order: value } satisfies SortOrderUpdateInputDto;
          await api(path, { method: "POST", body: JSON.stringify(body) });
        } catch (error) {
          reportError("save", error);
          throw new Error("排序保存失败，输入已保留，请重试");
        }
        try {
          await refresh();
        } catch (error) {
          reportError("refresh", error);
          throw new Error("排序已保存，但列表刷新失败，请重试");
        }
        const authoritativeValue = readValue(slug);
        if (authoritativeValue === undefined) throw new Error("列表已更新，该条目已不存在");
        return authoritativeValue;
      } finally {
        pendingRef.current.delete(path);
        if (mountedRef.current) setPendingPaths(new Set(pendingRef.current));
      }
    });
    queueRef.current = request.catch(() => undefined);
    return request;
  };

  return {
    busy: externalBusy || pendingPaths.size > 0,
    isSaving: (slug: string) => pendingPaths.has(`${basePath}/${slug}/sort-order`),
    save
  };
}
