import { useCallback, useRef, useState } from "react";
import type { AltchaWidgetElement } from "altcha";
import { api, clearCsrfToken, setCsrfToken } from "../../lib/api/client.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { adminApiBasePath } from "../../lib/constants.js";
import {
  clearSessionProbeHint,
  rememberSessionProbeHint
} from "../../lib/api/site-data.js";
import { cssUrl } from "../../lib/ui/formatters.js";
import { LoginChallenge } from "./LoginChallenge.js";

export function AdminLogin({
  siteName,
  onLogin,
  altchaEnabled,
  loginBackground
}: {
  siteName: string;
  onLogin: () => Promise<void>;
  altchaEnabled: boolean;
  loginBackground: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [challengeLoaded, setChallengeLoaded] = useState(!altchaEnabled);
  const [challengeVerified, setChallengeVerified] = useState(!altchaEnabled);
  const [challengeLoadFailed, setChallengeLoadFailed] = useState(false);
  const [challengeInstance, setChallengeInstance] = useState(0);
  const challengeRef = useRef<AltchaWidgetElement | null>(null);
  const submissionActiveRef = useRef(false);
  const automaticChallengeRetryUsedRef = useRef(false);
  const markChallengeReady = useCallback(() => {
    setChallengeLoaded(true);
    setChallengeLoadFailed(false);
    automaticChallengeRetryUsedRef.current = false;
  }, []);
  const markChallengeError = useCallback(() => {
    setChallengeLoaded(false);
    setChallengeVerified(false);
    if (!automaticChallengeRetryUsedRef.current) {
      automaticChallengeRetryUsedRef.current = true;
      setChallengeInstance((current) => current + 1);
      return;
    }
    setChallengeLoadFailed(true);
  }, []);
  const retryChallenge = useCallback(() => {
    automaticChallengeRetryUsedRef.current = true;
    setChallengeLoadFailed(false);
    setChallengeLoaded(false);
    setChallengeVerified(false);
    setChallengeInstance((current) => current + 1);
  }, []);

  const background = loginBackground || "/random?m=redirect";
  const credentialsComplete = username.trim().length > 0 && password.length > 0;
  const buttonLabel = loggingIn
    ? "登录中…"
    : !challengeLoaded
      ? "加载验证…"
      : "登录";

  return (
    <main
      className="login"
      style={{ backgroundImage: `linear-gradient(rgba(12, 18, 28, .45), rgba(12, 18, 28, .72)), ${cssUrl(background)}` }}
    >
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (submissionActiveRef.current || !credentialsComplete) return;
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
          const response = await api<{ csrf_token: string }>(`${adminApiBasePath}/auth/login`, {
            method: "POST",
            body: JSON.stringify({ username, password, ...(altcha ? { altcha } : {}) })
          });
          setCsrfToken(response.csrf_token);
          rememberSessionProbeHint();
          await onLogin();
        } catch (caught) {
          clearCsrfToken();
          clearSessionProbeHint();
          setError((caught as Error).message);
          if (altchaEnabled) {
            setChallengeVerified(false);
            challengeRef.current?.reset();
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
            <LoginChallenge
              key={challengeInstance}
              ref={challengeRef}
              onError={markChallengeError}
              onReady={markChallengeReady}
              onVerificationChange={setChallengeVerified}
            />
            {challengeLoadFailed && (
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
          disabled={!credentialsComplete || !challengeLoaded || !challengeVerified || loggingIn}
          type="submit"
        >
          {buttonLabel}
        </button>
      </form>
    </main>
  );
}
