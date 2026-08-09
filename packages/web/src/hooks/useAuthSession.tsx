import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  useQuery,
  type UseQueryResult
} from "@tanstack/react-query";
import { useLocation } from "react-router";
import {
  type AdminPermission
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
import { adminBasePath } from "../lib/constants.js";

const AuthSessionContext = createContext<UseQueryResult<AuthState> | null>(null);

function isAdminPath(pathname: string) {
  return pathname === adminBasePath || pathname.startsWith(`${adminBasePath}/`);
}

/**
 * Owns the SPA's only /auth/me observer and expired-session listener. Public
 * routes render immediately; they probe only when a persisted session hint is
 * present, while every admin route always confirms the authoritative session.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const adminRoute = isAdminPath(pathname);
  const [publicProbeRequested, setPublicProbeRequested] = useState(
    hasSessionProbeHint
  );
  const query = useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => readAuthSession(signal),
    enabled: adminRoute || publicProbeRequested,
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  });
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const [refreshCoordinator] = useState(
    () => new AuthSessionRefreshCoordinator()
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
      clearCsrfToken();
      clearSessionProbeHint();
      setPublicProbeRequested(true);
      void refreshCoordinator.run(async () => {
        await refetchRef.current({ cancelRefetch: false });
      }).catch(() => undefined);
    };
    window.addEventListener(authExpiredEvent, refreshAuth);
    return () => window.removeEventListener(authExpiredEvent, refreshAuth);
  }, [refreshCoordinator]);

  return (
    <AuthSessionContext.Provider value={query}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthMe() {
  const query = useContext(AuthSessionContext);
  if (!query) {
    throw new Error("useAuthMe must be used inside AuthSessionProvider");
  }
  return query;
}

const noAdminPermissions: readonly AdminPermission[] = [];

export function useAdminPermissions(): readonly AdminPermission[] {
  const { data } = useAuthMe();
  return data?.authenticated ? data.permissions : noAdminPermissions;
}
