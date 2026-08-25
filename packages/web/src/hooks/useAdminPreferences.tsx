import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminPreferenceKeys,
  defaultAdminPreferences,
  normalizeAdminPreferences,
  type AdminPreferenceKey,
  type AdminPreferences,
  type AdminPreferencesResponseDto,
  type AdminPreferenceValues
} from "@imageshow/shared/browser";
import { apiWithEtag } from "../lib/api/client.js";
import { adminApiBasePath } from "../lib/constants.js";
import { queryKeys } from "../lib/api/query-keys.js";
import {
  assignAdminPreference,
  reconcileAdminPreferenceCache,
  runAdminPreferenceWriteWithReadFence,
  sameAdminPreferences,
  shouldReplaceAdminPreferenceQuerySnapshot,
  type CachedAdminPreferences
} from "../lib/api/admin-preference-cache.js";
import { useAuthPreferenceCacheBridge } from "./useAuthSession.js";

const localPreferenceKeyPrefix = "imageshow.admin.preferences.";
const preferenceRevalidationIntervalMs = 5 * 60 * 1000;

type SetAdminPreference = <Key extends AdminPreferenceKey>(
  key: Key,
  value: AdminPreferenceValues[Key]
) => void;

type AdminPreferenceContextValue = {
  values: AdminPreferences;
  setPreference: SetAdminPreference;
};

type QueuedPreference = {
  value: AdminPreferenceValues[AdminPreferenceKey];
  version: number;
};

type AdminPreferencesQuerySnapshot = AdminPreferencesResponseDto & Readonly<{
  etag: string;
}>;

const AdminPreferenceContext = createContext<AdminPreferenceContextValue | null>(null);

function localPreferenceKey(username: string) {
  return `${localPreferenceKeyPrefix}${encodeURIComponent(username)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function preferenceCount(preferences: AdminPreferences) {
  return adminPreferenceKeys.reduce(
    (count, key) => count + (preferences[key] === undefined ? 0 : 1),
    0
  );
}

function sameCache(left: CachedAdminPreferences, right: CachedAdminPreferences) {
  return sameAdminPreferences(left.values, right.values)
    && sameAdminPreferences(left.pending, right.pending);
}

function emptyCache(): CachedAdminPreferences {
  return { values: {}, pending: {} };
}

function writeCachedPreferences(username: string, cache: CachedAdminPreferences) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      localPreferenceKey(username),
      JSON.stringify(cache)
    );
    return true;
  } catch {
    // 浏览器禁用 localStorage 时仍保留内存状态，并继续尝试 PostgreSQL 同步。
    return false;
  }
}

function readCachedPreferences(username: string): CachedAdminPreferences {
  if (typeof window === "undefined") return emptyCache();
  try {
    const storage = window.localStorage;
    const raw = storage.getItem(localPreferenceKey(username));
    if (raw === null) return emptyCache();
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return emptyCache();
    const pending = normalizeAdminPreferences(parsed.pending);
    return {
      values: {
        ...normalizeAdminPreferences(parsed.values),
        ...pending
      },
      pending
    };
  } catch {
    return emptyCache();
  }
}

export function AdminPreferencesProvider({
  username,
  serverPreferences,
  serverPreferencesEtag,
  serverPreferencesUpdatedAt,
  children
}: PropsWithChildren<{
  username: string;
  serverPreferences: AdminPreferences;
  serverPreferencesEtag: string;
  serverPreferencesUpdatedAt: number;
}>) {
  const queryClient = useQueryClient();
  const {
    cancelPendingAuthRead,
    updateAuthPreferenceSnapshot
  } = useAuthPreferenceCacheBridge();
  const queryKey = useMemo(
    () => [...queryKeys.adminPreferences, username] as const,
    [username]
  );
  const initialServerPreferences = useMemo(
    () => normalizeAdminPreferences(serverPreferences),
    [serverPreferences]
  );
  const [cache, setCache] = useState<CachedAdminPreferences>(
    () => reconcileAdminPreferenceCache(
      readCachedPreferences(username),
      initialServerPreferences
    )
  );
  const cacheRef = useRef(cache);
  const queueRef = useRef(Promise.resolve());
  const queuedPreferencesRef = useRef<Partial<Record<AdminPreferenceKey, QueuedPreference>>>({});
  const queueVersionRef = useRef(0);
  const activeUsernameRef = useRef<string | null>(username);

  useLayoutEffect(() => {
    activeUsernameRef.current = username;
    return () => {
      activeUsernameRef.current = null;
    };
  }, [username]);

  useLayoutEffect(() => {
    // 初始化 reconcile 可能已确认并移除上次遗留的 pending；即使内存状态没有
    // 后续变化，也要在页面可交互前把这份归一化结果写回，避免未来把旧 pending
    // 误当作尚未同步的本地选择。
    writeCachedPreferences(username, cacheRef.current);
  }, [username]);

  useLayoutEffect(() => {
    const cachedUpdatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
    if (!shouldReplaceAdminPreferenceQuerySnapshot(
      cachedUpdatedAt,
      serverPreferencesUpdatedAt
    )) return;
    queryClient.setQueryData<AdminPreferencesQuerySnapshot>(
      queryKey,
      {
        preferences: initialServerPreferences,
        etag: serverPreferencesEtag
      },
      { updatedAt: serverPreferencesUpdatedAt }
    );
  }, [
    initialServerPreferences,
    queryClient,
    queryKey,
    serverPreferencesEtag,
    serverPreferencesUpdatedAt
  ]);

  const commitCache = useCallback((next: CachedAdminPreferences) => {
    if (sameCache(cacheRef.current, next)) return;
    cacheRef.current = next;
    writeCachedPreferences(username, next);
    setCache(next);
  }, [username]);

  const syncAuthPreferenceSnapshot = useCallback((
    preferences: AdminPreferences,
    etag: string
  ) => {
    if (activeUsernameRef.current !== username) return;
    updateAuthPreferenceSnapshot(username, preferences, etag);
  }, [updateAuthPreferenceSnapshot, username]);

  const cancelPreferenceReads = useCallback(
    () => Promise.all([
      queryClient.cancelQueries(
        { queryKey, exact: true },
        { silent: true }
      ),
      cancelPendingAuthRead()
    ]).then(() => undefined),
    [cancelPendingAuthRead, queryClient, queryKey]
  );

  const enqueueSync = useCallback((requestedPatch: AdminPreferences) => {
    const patch: AdminPreferences = {};
    const ticketVersions: Partial<Record<AdminPreferenceKey, number>> = {};

    for (const key of adminPreferenceKeys) {
      const value = requestedPatch[key];
      if (value === undefined || queuedPreferencesRef.current[key]?.value === value) continue;
      const version = ++queueVersionRef.current;
      assignAdminPreference(patch, key, value);
      ticketVersions[key] = version;
      queuedPreferencesRef.current[key] = { value, version };
    }
    if (!preferenceCount(patch)) return;

    queueRef.current = queueRef.current.then(async () => {
      try {
        /*
         * A focus/reconnect GET may have captured the previous PostgreSQL value.
         * Cancel once before the PATCH and once after its acknowledgement so no
         * stale read can publish after pending is cleared.
         */
        const result = await runAdminPreferenceWriteWithReadFence(
          cancelPreferenceReads,
          () => apiWithEtag<AdminPreferencesResponseDto>(
            `${adminApiBasePath}/preferences`,
            {
              method: "PATCH",
              body: JSON.stringify(patch)
            }
          )
        );
        const response = result.data;
        const acknowledged = normalizeAdminPreferences(response.preferences);
        const current = cacheRef.current;
        const values = { ...current.values };
        const pending = { ...current.pending };

        for (const key of adminPreferenceKeys) {
          const sentValue = patch[key];
          const isLatestRequest = queuedPreferencesRef.current[key]?.version === ticketVersions[key];
          if (isLatestRequest && sentValue !== undefined && current.pending[key] === sentValue) {
            delete pending[key];
            assignAdminPreference(values, key, acknowledged[key] ?? sentValue);
            continue;
          }

          // PATCH 返回 PostgreSQL 中当前完整投影。未被本地更新占用的其他键也在此
          // 对齐服务端，但不能覆盖同一页面稍后排队或仍待同步的值。
          if (current.pending[key] !== undefined || queuedPreferencesRef.current[key]) continue;
          const acknowledgedValue = acknowledged[key];
          if (acknowledgedValue === undefined) delete values[key];
          else assignAdminPreference(values, key, acknowledgedValue);
        }
        commitCache({ values, pending });

        queryClient.setQueryData<AdminPreferencesQuerySnapshot>(queryKey, {
          preferences: acknowledged,
          etag: result.etag
        });
        syncAuthPreferenceSnapshot(acknowledged, result.etag);
      } catch {
        // PostgreSQL 或网络暂时不可用时保留 pending；网络恢复或下次登录会再次补同步。
      } finally {
        for (const key of adminPreferenceKeys) {
          if (queuedPreferencesRef.current[key]?.version === ticketVersions[key]) {
            delete queuedPreferencesRef.current[key];
          }
        }
      }
    });
  }, [
    cancelPreferenceReads,
    commitCache,
    queryClient,
    queryKey,
    syncAuthPreferenceSnapshot
  ]);

  const preferenceQuery = useQuery<AdminPreferencesQuerySnapshot>({
    queryKey,
    queryFn: async ({ signal }) => {
      const current = queryClient.getQueryData<AdminPreferencesQuerySnapshot>(
        queryKey
      ) ?? {
        preferences: initialServerPreferences,
        etag: serverPreferencesEtag
      };
      const result = await apiWithEtag<AdminPreferencesResponseDto>(
        `${adminApiBasePath}/preferences`,
        { signal },
        {
          etag: current.etag,
          data: { preferences: current.preferences }
        }
      );
      return { ...result.data, etag: result.etag };
    },
    // /auth/me 已携带 PostgreSQL 快照，作为后台首帧种子避免额外请求和外观闪烁。
    // 五分钟内复用 /auth/me 或上次条件读取的快照；更久后聚焦 / 重连才重验证，
    // 服务端 ETag 会让未变化的偏好只产生 304 而不重复传输 JSON。
    initialData: {
      preferences: initialServerPreferences,
      etag: serverPreferencesEtag
    },
    initialDataUpdatedAt: serverPreferencesUpdatedAt,
    staleTime: preferenceRevalidationIntervalMs,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1
  });

  useEffect(() => {
    if (!preferenceQuery.data) return;
    if (preferenceQuery.dataUpdatedAt < serverPreferencesUpdatedAt) return;
    const serverPreferences = normalizeAdminPreferences(preferenceQuery.data.preferences);
    const next = reconcileAdminPreferenceCache(cacheRef.current, serverPreferences);
    commitCache(next);
    enqueueSync(next.pending);
    syncAuthPreferenceSnapshot(serverPreferences, preferenceQuery.data.etag);
  }, [
    commitCache,
    enqueueSync,
    preferenceQuery.data,
    preferenceQuery.dataUpdatedAt,
    serverPreferencesUpdatedAt,
    syncAuthPreferenceSnapshot
  ]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== localPreferenceKey(username)) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        // 存储被浏览器策略禁用时忽略跨标签事件，当前页仍使用内存与服务端状态。
        return;
      }
      const next = readCachedPreferences(username);
      cacheRef.current = next;
      setCache(next);
      enqueueSync(next.pending);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [enqueueSync, username]);

  useEffect(() => {
    const retryPendingPreferences = () => {
      // 等待可能仍在收尾的失败请求释放队列，再读取最新 pending，避免 online
      // 事件恰好早于请求 finally 时被“同值已排队”判断吞掉。
      void queueRef.current.then(() => enqueueSync(cacheRef.current.pending));
    };
    window.addEventListener("online", retryPendingPreferences);
    return () => {
      window.removeEventListener("online", retryPendingPreferences);
    };
  }, [enqueueSync]);

  const setPreference = useCallback<SetAdminPreference>((key, value) => {
    const current = cacheRef.current;
    const values = { ...current.values };
    const pending = { ...current.pending };
    const patch: AdminPreferences = {};
    assignAdminPreference(values, key, value);
    assignAdminPreference(pending, key, value);
    assignAdminPreference(patch, key, value);
    commitCache({ values, pending });
    enqueueSync(patch);
  }, [commitCache, enqueueSync]);

  const contextValue = useMemo<AdminPreferenceContextValue>(() => ({
    values: cache.values,
    setPreference
  }), [cache.values, setPreference]);

  return (
    <AdminPreferenceContext.Provider value={contextValue}>
      {children}
    </AdminPreferenceContext.Provider>
  );
}

export function useAdminPreference<Key extends AdminPreferenceKey>(
  key: Key
): [AdminPreferenceValues[Key], (value: AdminPreferenceValues[Key]) => void] {
  const preferences = useContext(AdminPreferenceContext);
  if (!preferences) {
    throw new Error("useAdminPreference must be used inside AdminPreferencesProvider");
  }
  return [
    preferences.values[key] ?? defaultAdminPreferences[key],
    (value) => preferences.setPreference(key, value)
  ];
}
