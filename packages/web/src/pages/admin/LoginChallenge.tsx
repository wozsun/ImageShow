import { forwardRef, useCallback } from "react";
import type { ForwardedRef } from "react";
import type { AltchaWidgetElement } from "altcha";
import type { AltchaGlobal } from "altcha/types";
import type {} from "altcha/types/react";
import { altchaSolveTimeoutMs } from "@imageshow/shared/browser";
import "altcha/external";
import "altcha/altcha.css";
import "altcha/i18n/zh-cn";
import pbkdf2WorkerUrl from "altcha/workers/pbkdf2?worker&url";
import { adminApiBasePath } from "../../lib/constants.js";

type TrustedScriptUrlPolicy = {
  createScriptURL(value: string): unknown;
};

type TrustedTypesFactory = {
  createPolicy(
    name: string,
    rules: { createScriptURL(value: string): string }
  ): TrustedScriptUrlPolicy;
};

const trustedTypes = (globalThis as typeof globalThis & {
  trustedTypes?: TrustedTypesFactory;
}).trustedTypes;

const altchaWorkerPolicy = trustedTypes?.createPolicy("imageshow-altcha-worker", {
  createScriptURL(value) {
    if (value !== pbkdf2WorkerUrl) {
      throw new TypeError("Unexpected ALTCHA worker URL");
    }
    return value;
  }
});

function createPbkdf2Worker() {
  const workerUrl = altchaWorkerPolicy
    ? altchaWorkerPolicy.createScriptURL(pbkdf2WorkerUrl)
    : pbkdf2WorkerUrl;

  // TypeScript's DOM declarations do not yet include TrustedScriptURL in the
  // Worker overload. This assertion changes only the compile-time type; the
  // browser still receives the TrustedScriptURL object returned by the policy.
  return new Worker(workerUrl as string);
}

const altchaGlobal = (globalThis as typeof globalThis & { $altcha: AltchaGlobal }).$altcha;
const altchaInitialDisplayDefaults = {
  hideFooter: true,
  hideLogo: true
} as const;

// ALTCHA applies the per-widget `configuration` attribute in an effect after
// its first render. Seed the same values globally so that initial render never
// mounts a dynamic-HTML footer that Trusted Types would reject.
altchaGlobal.defaults.set(altchaInitialDisplayDefaults);
altchaGlobal.algorithms.set("PBKDF2/SHA-256", createPbkdf2Worker);

const altchaWidgetConfiguration = JSON.stringify({
  ...altchaInitialDisplayDefaults,
  humanInteractionSignature: false,
  minDuration: 500,
  timeout: altchaSolveTimeoutMs,
  validationMessage: "请完成安全验证"
});
const altchaWidgetAttributes: Record<string, string | number> = {
  auto: "onload",
  challenge: `${adminApiBasePath}/auth/challenge`,
  configuration: altchaWidgetConfiguration,
  display: "standard",
  language: "zh-cn",
  name: "altcha",
  workers: 2
};

type LoginChallengeProps = {
  onError: () => void;
  onReady: () => void;
  onVerificationChange: (verified: boolean) => void;
};

function assignRef(ref: ForwardedRef<AltchaWidgetElement>, value: AltchaWidgetElement | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function AltchaMark() {
  return (
    <svg
      className="login-altcha-mark"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2.33955 16.4279C5.88954 20.6586 12.1971 21.2105 16.4279 17.6604C18.4699 15.947 19.6548 13.5911 19.9352 11.1365L17.9886 10.4279C17.8738 12.5624 16.909 14.6459 15.1423 16.1284C11.7577 18.9684 6.71167 18.5269 3.87164 15.1423C1.03163 11.7577 1.4731 6.71166 4.8577 3.87164C8.24231 1.03162 13.2883 1.4731 16.1284 4.8577C16.9767 5.86872 17.5322 7.02798 17.804 8.2324L19.9522 9.01429C19.7622 7.07737 19.0059 5.17558 17.6604 3.57212C14.1104 -0.658624 7.80283 -1.21043 3.57212 2.33956C-0.658625 5.88958 -1.21046 12.1971 2.33955 16.4279Z"
        fill="currentColor"
      />
      <path
        d="M3.57212 2.33956C1.65755 3.94607 0.496389 6.11731 0.12782 8.40523L2.04639 9.13961C2.26047 7.15832 3.21057 5.25375 4.8577 3.87164C8.24231 1.03162 13.2883 1.4731 16.1284 4.8577L13.8302 6.78606L19.9633 9.13364C19.7929 7.15555 19.0335 5.20847 17.6604 3.57212C14.1104 -0.658624 7.80283 -1.21043 3.57212 2.33956Z"
        fill="currentColor"
      />
      <path
        d="M7 10H5C5 12.7614 7.23858 15 10 15C12.7614 15 15 12.7614 15 10H13C13 11.6569 11.6569 13 10 13C8.3431 13 7 11.6569 7 10Z"
        fill="currentColor"
      />
    </svg>
  );
}

export const LoginChallenge = forwardRef<AltchaWidgetElement, LoginChallengeProps>(
  function LoginChallenge({ onError, onReady, onVerificationChange }, forwardedRef) {
    const setRef = useCallback((element: AltchaWidgetElement | null) => {
      assignRef(forwardedRef, element);
      if (!element) return;
      let ready = false;
      const reportState = (state: string | undefined) => {
        if (state) onVerificationChange(state === "verified");
      };
      const markReady = () => {
        if (ready) return;
        ready = true;
        clearTimeout(loadTimeout);
        onReady();
        reportState(element.getState());
      };
      const handleStateChange = (event: Event) => {
        const state = (event as CustomEvent<{ state?: string }>).detail?.state;
        reportState(state);
      };
      const preventVerifiedReset = (event: Event) => {
        if (element.getState() !== "verified") return;
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".altcha-checkbox-wrap")) return;
        event.preventDefault();
      };
      const loadTimeout = window.setTimeout(() => {
        if (!ready) onError();
      }, 5000);

      // ALTCHA 的实例方法只在自定义 load 事件后可用。监听事件之外再安排一次
      // 微任务检查也覆盖组件在 React ref 回调前已经完成挂载的时序。
      element.addEventListener("load", markReady, { once: true });
      element.addEventListener("statechange", handleStateChange);
      element.addEventListener("click", preventVerifiedReset, true);
      queueMicrotask(() => {
        if (!element.isConnected || ready) return;
        try {
          element.getConfiguration();
          markReady();
        } catch {
          // 尚未完成挂载时继续等待 load 事件。
        }
      });

      return () => {
        clearTimeout(loadTimeout);
        element.removeEventListener("load", markReady);
        element.removeEventListener("statechange", handleStateChange);
        element.removeEventListener("click", preventVerifiedReset, true);
        assignRef(forwardedRef, null);
      };
    }, [forwardedRef, onError, onReady, onVerificationChange]);

    return (
      <div className="login-altcha-shell">
        <altcha-widget ref={setRef} className="login-altcha" {...altchaWidgetAttributes} />
        <AltchaMark />
      </div>
    );
  }
);
