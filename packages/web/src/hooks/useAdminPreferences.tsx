import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminPreferenceKeys,
  normalizeAdminPreferences,
  type AdminPreferenceKey,
  type AdminPreferences,
  type AdminPreferenceValues
} from "@imageshow/shared/browser";
import { api } from "../lib/api/client.js";
import { adminApiBasePath } from "../lib/constants.js";
import { queryKeys } from "../lib/api/query-keys.js";

const localPreferenceVersion = 1;
const localPreferenceKeyPrefix = "imageshow.admin.preferences.";

type CachedAdminPreferences = {
  values: AdminPreferences;
  pending: AdminPreferences;
};

type AdminPreferenceResponse = {
  preferences: AdminPreferences;
};

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

const AdminPreferenceContext = createContext<AdminPreferenceContextValue | null>(null);

function localPreferenceKey(username: string) {
  return `${localPreferenceKeyPrefix}${encodeURIComponent(username)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assignPreference<Key extends AdminPreferenceKey>(
  preferences: AdminPreferences,
  key: Key,
  value: AdminPreferenceValues[Key]
) {
  Object.assign(preferences, { [key]: value });
}

function preferenceCount(preferences: AdminPreferences) {
  return adminPreferenceKeys.reduce(
    (count, key) => count + (preferences[key] === undefined ? 0 : 1),
    0
  );
}

function samePreferences(left: AdminPreferences, right: AdminPreferences) {
  return adminPreferenceKeys.every((key) => left[key] === right[key]);
}

function sameCache(left: CachedAdminPreferences, right: CachedAdminPreferences) {
  return samePreferences(left.values, right.values)
    && samePreferences(left.pending, right.pending);
}

function emptyCache(): CachedAdminPreferences {
  return { values: {}, pending: {} };
}

function writeCachedPreferences(username: string, cache: CachedAdminPreferences) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      localPreferenceKey(username),
      JSON.stringify({ version: localPreferenceVersion, ...cache })
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
    if (!isRecord(parsed) || parsed.version !== localPreferenceVersion) return emptyCache();
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
  children
}: PropsWithChildren<{ username: string }>) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => [...queryKeys.adminPreferences, username] as const,
    [username]
  );
  const [cache, setCache] = useState<CachedAdminPreferences>(
    () => readCachedPreferences(username)
  );
  const cacheRef = useRef(cache);
  const queueRef = useRef(Promise.resolve());
  const queuedPreferencesRef = useRef<Partial<Record<AdminPreferenceKey, QueuedPreference>>>({});
  const queueVersionRef = useRef(0);

  const commitCache = useCallback((next: CachedAdminPreferences) => {
    if (sameCache(cacheRef.current, next)) return;
    cacheRef.current = next;
    writeCachedPreferences(username, next);
    setCache(next);
  }, [username]);

  const enqueueSync = useCallback((requestedPatch: AdminPreferences) => {
    const patch: AdminPreferences = {};
    const ticketVersions: Partial<Record<AdminPreferenceKey, number>> = {};

    for (const key of adminPreferenceKeys) {
      const value = requestedPatch[key];
      if (value === undefined || queuedPreferencesRef.current[key]?.value === value) continue;
      const version = ++queueVersionRef.current;
      assignPreference(patch, key, value);
      ticketVersions[key] = version;
      queuedPreferencesRef.current[key] = { value, version };
    }
    if (!preferenceCount(patch)) return;

    queueRef.current = queueRef.current.then(async () => {
      try {
        const response = await api<AdminPreferenceResponse>(`${adminApiBasePath}/preferences`, {
          method: "PATCH",
          body: JSON.stringify(patch)
        });
        const acknowledged = normalizeAdminPreferences(response.preferences);
        const current = cacheRef.current;
        const values = { ...current.values };
        const pending = { ...current.pending };

        for (const key of adminPreferenceKeys) {
          const sentValue = patch[key];
          const isLatestRequest = queuedPreferencesRef.current[key]?.version === ticketVersions[key];
          if (isLatestRequest && sentValue !== undefined && current.pending[key] === sentValue) {
            delete pending[key];
            assignPreference(values, key, acknowledged[key] ?? sentValue);
            continue;
          }

          // PATCH 返回 PostgreSQL 中当前完整投影。未被本地更新占用的其他键也在此
          // 对齐服务端，但不能覆盖同一页面稍后排队或仍待同步的值。
          if (current.pending[key] !== undefined || queuedPreferencesRef.current[key]) continue;
          const acknowledgedValue = acknowledged[key];
          if (acknowledgedValue === undefined) delete values[key];
          else assignPreference(values, key, acknowledgedValue);
        }
        commitCache({ values, pending });

        queryClient.setQueryData<AdminPreferenceResponse>(queryKey, {
          preferences: acknowledged
        });
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
  }, [commitCache, queryClient, queryKey]);

  const preferenceQuery = useQuery<AdminPreferenceResponse>({
    queryKey,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/preferences`, { signal }),
    // 当前页面内以本地状态和 PATCH 回执为准；刷新或重新登录后再读取服务端。
    // 普通 reconnect 只会重试尚未成功加载的查询，不会刷新已经成功的无限新鲜数据。
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 1
  });

  useEffect(() => {
    if (!preferenceQuery.data) return;
    const serverPreferences = normalizeAdminPreferences(preferenceQuery.data.preferences);
    const current = cacheRef.current;
    const values = { ...current.values };
    const pending = { ...current.pending };
    const patch: AdminPreferences = {};

    for (const key of adminPreferenceKeys) {
      const pendingValue = current.pending[key];
      const serverValue = serverPreferences[key];
      const localValue = current.values[key];

      if (pendingValue !== undefined) {
        assignPreference(values, key, pendingValue);
        assignPreference(patch, key, pendingValue);
      } else if (serverValue !== undefined) {
        assignPreference(values, key, serverValue);
      } else if (localValue !== undefined) {
        assignPreference(pending, key, localValue);
        assignPreference(patch, key, localValue);
      }
    }

    commitCache({ values, pending });
    enqueueSync(patch);
  }, [commitCache, enqueueSync, preferenceQuery.data]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== localPreferenceKey(username)) return;
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
    assignPreference(values, key, value);
    assignPreference(pending, key, value);
    assignPreference(patch, key, value);
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
  key: Key,
  fallback: AdminPreferenceValues[Key]
): [AdminPreferenceValues[Key], (value: AdminPreferenceValues[Key]) => void] {
  const preferences = useContext(AdminPreferenceContext);
  if (!preferences) {
    throw new Error("useAdminPreference must be used inside AdminPreferencesProvider");
  }
  return [
    preferences.values[key] ?? fallback,
    (value) => preferences.setPreference(key, value)
  ];
}
