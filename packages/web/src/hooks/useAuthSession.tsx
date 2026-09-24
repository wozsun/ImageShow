import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useLocation } from "react-router";
import {
  normalizeAdminPreferences,
  type AdminPermission,
  type AdminPreferences,
  type AuthStateDto
} from "@imageshow/shared/browser";
import { authExpiredEvent, clearCsrfToken } from "../lib/api/client.js";
import {
  AuthSessionRefreshCoordinator,
  clearSessionProbeHint,
  hasSessionProbeHint,
  readAuthSession,
  synchronizeAuthSession,
  type AuthState
} from "../lib/api/auth-session.js";
import { queryKeys } from "../lib/api/query-keys.js";
import { sameAdminPreferences } from "../lib/api/admin-preference-cache.js";
import { adminBasePath } from "../lib/constants.js";

type AuthSessionContextValue = Readonly<{
  query: UseQueryResult<AuthState>;
  recoverAuthSession: () => Promise<void>;
}>;

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

function isAdminPath(pathname: string) {
  return pathname === adminBasePath || pathname.startsWith(`${adminBasePath}/`);
}

/**
 * Owns the only /auth/me observer and expired-session listener for normal public
 * and admin routes. Public routes probe only with a persisted session hint;
 * admin routes always confirm the session. Embedded routes omit this provider.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { pathname } = useLocation();
  const adminRoute = isAdminPath(pathname);
  const [publicProbeRequested, setPublicProbeRequested] = useState(hasSessionProbeHint);
  const query = useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => readAuthSession(signal),
    enabled: adminRoute || publicProbeRequested,
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  });
  const [refreshCoordinator] = useState(() => new AuthSessionRefreshCoordinator());
  const { refetch: refetchQuery } = query;
  const refetch = useCallback<typeof refetchQuery>(
    async (options) => {
      // Login confirmation and recovery can outlive the route owning this session.
      if (!active.current) throw new DOMException("会话刷新已取消", "AbortError");
      return refetchQuery(options);
    },
    [refetchQuery]
  );
  const recoverAuthSession = useCallback(
    () =>
      refreshCoordinator.run(async () => {
        const result = await refetch({ cancelRefetch: false });
        if (!active.current) throw new DOMException("会话恢复已取消", "AbortError");
        if (result.error) throw result.error;
        if (!result.data?.authenticated) {
          throw new Error("管理员登录已失效");
        }
      }),
    [refetch, refreshCoordinator]
  );

  useEffect(() => {
    if (!query.data) return;
    // 偏好保存可直接更新认证缓存；唯一 owner 同样负责恢复会话副作用。
    synchronizeAuthSession(query.data);
    if (query.data.authenticated) {
      setPublicProbeRequested(true);
    } else if (!adminRoute) {
      setPublicProbeRequested(false);
    }
  }, [adminRoute, query.data]);

  useEffect(() => {
    const refreshAuth = () => {
      if (!active.current) return;
      clearCsrfToken();
      clearSessionProbeHint();
      setPublicProbeRequested(true);
      void recoverAuthSession().catch(() => undefined);
    };
    window.addEventListener(authExpiredEvent, refreshAuth);
    return () => window.removeEventListener(authExpiredEvent, refreshAuth);
  }, [recoverAuthSession]);

  return (
    <AuthSessionContext.Provider value={{ query: { ...query, refetch }, recoverAuthSession }}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthSessionQuery() {
  const query = useOptionalAuthSessionQuery();
  if (!query) {
    throw new Error("useAuthSessionQuery must be used inside AuthSessionProvider");
  }
  return query;
}

/** Public image details remain guest-only outside a session-owning route. */
export function useOptionalAuthSessionQuery() {
  return useContext(AuthSessionContext)?.query;
}

export function useOptionalAuthSessionRecovery() {
  return useContext(AuthSessionContext)?.recoverAuthSession;
}

/**
 * Keeps preference writes behind the sole /auth/me query owner. A preference
 * PATCH must fence a captured old auth response before publishing its new
 * preference snapshot and validator into the shared authentication cache.
 */
export function useAuthPreferenceCacheBridge() {
  const queryClient = useQueryClient();
  const cancelPendingAuthRead = useCallback(
    () => queryClient.cancelQueries({ queryKey: queryKeys.me, exact: true }, { silent: true }),
    [queryClient]
  );
  const updateAuthPreferenceSnapshot = useCallback(
    (username: string, preferences: AdminPreferences, etag: string) => {
      const current = queryClient.getQueryData<AuthStateDto>(queryKeys.me);
      if (!current?.authenticated || current.username !== username) return;
      if (
        sameAdminPreferences(normalizeAdminPreferences(current.preferences), preferences) &&
        current.preferences_etag === etag
      )
        return;
      const next: Extract<AuthStateDto, { authenticated: true }> = {
        ...current,
        preferences,
        preferences_etag: etag
      };
      queryClient.setQueryData<AuthStateDto>(queryKeys.me, next);
    },
    [queryClient]
  );

  return { cancelPendingAuthRead, updateAuthPreferenceSnapshot };
}

const noAdminPermissions: readonly AdminPermission[] = [];

export function useAdminPermissions(): readonly AdminPermission[] {
  const { data } = useAuthSessionQuery();
  return data?.authenticated ? data.permissions : noAdminPermissions;
}
