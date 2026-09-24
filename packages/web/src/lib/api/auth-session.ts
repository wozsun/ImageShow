import type { AuthStateDto } from "@imageshow/shared/browser";
import {
  api,
  clearCsrfToken,
  isApiClientError,
  setCsrfToken
} from "./client.js";
import { adminApiBasePath } from "../constants.js";

export type AuthState = AuthStateDto;

const sessionProbeHintKey = "site_session_hint";

export function hasSessionProbeHint() {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(sessionProbeHintKey) === "1";
  } catch {
    return false;
  }
}

export function rememberSessionProbeHint() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(sessionProbeHintKey, "1");
  } catch {
    // 忽略无痕模式或浏览器策略导致的本地存储失败。
  }
}

export function clearSessionProbeHint() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(sessionProbeHintKey);
  } catch {
    // 忽略无痕模式或浏览器策略导致的本地存储失败。
  }
}

export function synchronizeAuthSession(auth: AuthState) {
  if (auth.authenticated) {
    if (auth.csrf_token) setCsrfToken(auth.csrf_token);
    else clearCsrfToken();
    rememberSessionProbeHint();
    return;
  }
  clearCsrfToken();
  clearSessionProbeHint();
}

export async function readAuthSession(signal?: AbortSignal) {
  try {
    const auth = await api<AuthState>(`${adminApiBasePath}/auth/me`, { signal });
    // 查询结果发布前先同步 CSRF；公共详情紧随其后的受保护预取不能看到空 token。
    synchronizeAuthSession(auth);
    return auth;
  } catch (error) {
    if (isApiClientError(error) && error.status === 401) {
      // 公开详情不会为本地提示位提前挂载管理模块，因此过期探针必须在
      // 认证读取边界立即收口。403 只拒绝当前能力，不据此删除会话提示。
      clearCsrfToken();
      clearSessionProbeHint();
    }
    throw error;
  }
}

/** Coalesces a burst of expired-session events into one authoritative probe. */
export class AuthSessionRefreshCoordinator {
  #pending: Promise<void> | null = null;

  run(refresh: () => Promise<unknown>) {
    if (this.#pending) return this.#pending;
    const pending = Promise.resolve()
      .then(refresh)
      .then(() => undefined);
    this.#pending = pending;
    void pending.then(
      () => {
        if (this.#pending === pending) this.#pending = null;
      },
      () => {
        if (this.#pending === pending) this.#pending = null;
      }
    );
    return pending;
  }
}
