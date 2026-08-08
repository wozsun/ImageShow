import { Component, Suspense, lazy, useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AltchaWidgetElement } from "altcha";
import type { AdminLoginResultDto } from "@imageshow/shared/browser";
import { api, clearCsrfToken, setCsrfToken } from "../../lib/api/client.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { adminApiBasePath } from "../../lib/constants.js";
import {
  clearSessionProbeHint,
  rememberSessionProbeHint
} from "../../lib/api/site-data.js";
import { cssUrl } from "../../lib/ui/formatters.js";
import { establishAndConfirmAdminSession } from "./admin-login-session.js";
import { useLoginVisualViewport } from "./useLoginVisualViewport.js";
// 登录页复用管理表单色契约，但不加载认证后才需要的 admin-core 布局。
import "../../styles/admin/semantic-colors.css";
import "../../styles/admin/login.css";

const LoginChallenge = lazy(() => import("./LoginChallenge.js").then((module) => ({
  default: module.LoginChallenge
})));

class LoginChallengeModuleBoundary extends Component<{
  children: ReactNode;
  onError: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function AdminLogin({
  siteName,
  onLogin,
  altchaEnabled,
  loginBackground
}: {
  siteName: string;
  onLogin: () => Promise<boolean>;
  altchaEnabled: boolean;
  loginBackground: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [challengeLoaded, setChallengeLoaded] = useState(!altchaEnabled);
  const [challengeVerified, setChallengeVerified] = useState(!altchaEnabled);
  const [challengeFailure, setChallengeFailure] = useState<"module" | "runtime" | null>(null);
  const [challengeInstance, setChallengeInstance] = useState(0);
  const [serverSessionEstablished, setServerSessionEstablished] = useState(false);
  const loginRef = useLoginVisualViewport();
  const challengeRef = useRef<AltchaWidgetElement | null>(null);
  const serverSessionRef = useRef({ established: false });
  const submissionActiveRef = useRef(false);
  const automaticChallengeRetryUsedRef = useRef(false);
  const markChallengeReady = useCallback(() => {
    setChallengeLoaded(true);
    setChallengeFailure(null);
  }, []);
  const markChallengeVerification = useCallback((verified: boolean) => {
    setChallengeVerified(verified);
    if (verified) automaticChallengeRetryUsedRef.current = false;
  }, []);
  const markChallengeRuntimeError = useCallback(() => {
    setChallengeLoaded(false);
    setChallengeVerified(false);
    if (!automaticChallengeRetryUsedRef.current) {
      automaticChallengeRetryUsedRef.current = true;
      setChallengeInstance((current) => current + 1);
      return;
    }
    setChallengeFailure("runtime");
  }, []);
  const markChallengeModuleError = useCallback(() => {
    setChallengeLoaded(false);
    setChallengeVerified(false);
    setChallengeFailure("module");
  }, []);
  const retryChallenge = useCallback(() => {
    // 失败过的模块 URL 会被当前页面的模块加载器缓存；重新载入页面才能真正
    // 发起新请求。组件运行失败则复用已经下载的模块，仅重建 widget 实例。
    if (challengeFailure === "module") {
      location.reload();
      return;
    }
    automaticChallengeRetryUsedRef.current = true;
    setChallengeFailure(null);
    setChallengeLoaded(false);
    setChallengeVerified(false);
    setChallengeInstance((current) => current + 1);
  }, [challengeFailure]);

  const background = loginBackground || "/random?m=redirect";
  const credentialsComplete = username.trim().length > 0 && password.length > 0;
  let buttonLabel = "登录";
  if (serverSessionEstablished) {
    buttonLabel = loggingIn ? "进入后台…" : "重新加载后台";
  } else if (loggingIn) {
    buttonLabel = "登录中…";
  } else if (!challengeLoaded) {
    buttonLabel = "加载验证…";
  }

  return (
    <main
      ref={loginRef}
      className="login"
      style={{
        backgroundImage: `linear-gradient(var(--admin-color-login-overlay-start), var(--admin-color-login-overlay-end)), ${cssUrl(background)}`
      }}
    >
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (submissionActiveRef.current) return;
        if (serverSessionRef.current.established) {
          // 浏览器会缓存同一页面里失败过的模块导入；新页面既会重新请求资源，
          // 又会创建全新 QueryClient，因此无需重复登录或清理旧用户缓存。
          location.reload();
          return;
        }
        if (!credentialsComplete) return;
        let altcha: string | undefined;
        if (altchaEnabled) {
          const proof = new FormData(event.currentTarget).get("altcha");
          if (typeof proof !== "string" || proof.length === 0) return;
          altcha = proof;
        }

        submissionActiveRef.current = true;
        setError("");
        setLoggingIn(true);
        try {
          const authenticated = await establishAndConfirmAdminSession(
            serverSessionRef.current,
            async () => {
              const response = await api<AdminLoginResultDto>(`${adminApiBasePath}/auth/login`, {
                method: "POST",
                body: JSON.stringify({ username, password, ...(altcha ? { altcha } : {}) })
              });
              setCsrfToken(response.csrf_token);
              rememberSessionProbeHint();
              setServerSessionEstablished(true);
            },
            onLogin
          );
          if (authenticated) return;

          clearCsrfToken();
          clearSessionProbeHint();
          setServerSessionEstablished(false);
          setError("登录状态确认失败，请重新登录");
          if (altchaEnabled) {
            setChallengeVerified(false);
            challengeRef.current?.reset();
          }
          submissionActiveRef.current = false;
          setLoggingIn(false);
        } catch (caught) {
          if (serverSessionRef.current.established) {
            setError("登录已成功，但后台加载失败，请重新加载后台");
          } else {
            clearCsrfToken();
            clearSessionProbeHint();
            setError((caught as Error).message);
            if (altchaEnabled) {
              setChallengeVerified(false);
              challengeRef.current?.reset();
            }
          }
          submissionActiveRef.current = false;
          setLoggingIn(false);
        }
      }}>
        <a className="login-site-title" href="/"><h1>{siteName}</h1></a>
        <input
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="用户名"
          autoComplete="username"
        />
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder="密码"
          autoComplete="current-password"
        />
        {altchaEnabled && (
          <div className="login-challenge-slot">
            <LoginChallengeModuleBoundary
              key={challengeInstance}
              onError={markChallengeModuleError}
            >
              <Suspense fallback={null}>
                <LoginChallenge
                  ref={challengeRef}
                  onError={markChallengeRuntimeError}
                  onReady={markChallengeReady}
                  onVerificationChange={markChallengeVerification}
                />
              </Suspense>
            </LoginChallengeModuleBoundary>
            {challengeFailure && (
              <button className="login-challenge-retry" type="button" onClick={retryChallenge}>
                安全验证加载失败，点击重试
              </button>
            )}
          </div>
        )}
        {error && <p className="error" role="alert" title={error}>{error}</p>}
        <button
          id="admin-login-submit"
          className="button"
          disabled={
            loggingIn
            || (
              !serverSessionEstablished
              && (!credentialsComplete || !challengeLoaded || !challengeVerified)
            )
          }
          type="submit"
        >
          {buttonLabel}
        </button>
      </form>
    </main>
  );
}
