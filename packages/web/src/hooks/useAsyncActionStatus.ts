import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultAsyncActionMinimumPendingMs,
  waitForMinimumPendingDuration
} from "../lib/ui/async-action-timing.js";

export type AsyncActionStatus = "idle" | "pending" | "success" | "error";

const defaultMinimumPendingMs = defaultAsyncActionMinimumPendingMs;
const defaultResultDurationMs = 5_000;

/**
 * 管理按钮型异步操作的短生命周期。pending 至少展示指定时长以避免闪屏，
 * success/error 保留一段时间后自动回到 idle；业务错误仍由调用方记录和处理。
 */
export function useAsyncActionStatus({
  minimumPendingMs = defaultMinimumPendingMs,
  resultDurationMs = defaultResultDurationMs,
  successDurationMs = resultDurationMs,
  errorDurationMs = resultDurationMs
}: {
  minimumPendingMs?: number;
  /** null 表示两种结果均由页面本身呈现，最短进行态结束后直接回到 idle。 */
  resultDurationMs?: number | null;
  /** 单独覆盖成功态；适用于成功后关闭弹窗或出现新内容的操作。 */
  successDurationMs?: number | null;
  /** 单独覆盖失败态；通常保留默认值以便原位重试。 */
  errorDurationMs?: number | null;
} = {}) {
  const [status, setStatus] = useState<AsyncActionStatus>("idle");
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const run = useCallback(async (operation: () => Promise<boolean>) => {
    if (runningRef.current) return false;
    runningRef.current = true;
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setStatus("pending");

    const startedAt = Date.now();
    let successful = false;
    let operationFailed = false;
    let operationError: unknown;
    try {
      successful = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    await waitForMinimumPendingDuration(startedAt, minimumPendingMs);

    if (mountedRef.current) {
      const nextStatus = successful && !operationFailed ? "success" : "error";
      const nextDurationMs = nextStatus === "success"
        ? successDurationMs
        : errorDurationMs;
      if (nextDurationMs === null || nextDurationMs <= 0) {
        setStatus("idle");
      } else {
        setStatus(nextStatus);
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null;
          if (mountedRef.current) setStatus("idle");
        }, nextDurationMs);
      }
    }
    runningRef.current = false;

    if (operationFailed) throw operationError;
    return successful;
  }, [errorDurationMs, minimumPendingMs, successDurationMs]);

  return {
    status,
    pending: status === "pending",
    run
  };
}
