import type { Readable } from "node:stream";
import { ApiError } from "../core/api-error.ts";
import type { StorageRequestOptions } from "./driver.ts";

type S3RequestRuntimeOptions = {
  idleTimeoutMs: number;
  taskTimeoutMs: number;
};

type TimeoutReadable = Readable & {
  setTimeout?: (milliseconds: number, callback?: () => void) => unknown;
};

function checkedTimeout(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function storageTimeout(kind: "idle" | "task" | "transport") {
  return new ApiError(
    504,
    "storage_timeout",
    kind === "idle"
      ? "S3 response body remained idle past its configured deadline"
      : kind === "task"
        ? "S3 request exceeded its configured total deadline"
        : "S3 transport exceeded its configured deadline"
  );
}

function isTransportTimeout(error: unknown) {
  const value = error as {
    name?: unknown;
    code?: unknown;
    cause?: { name?: unknown; code?: unknown };
  };
  return value?.name === "TimeoutError"
    || value?.code === "ETIMEDOUT"
    || value?.cause?.name === "TimeoutError"
    || value?.cause?.code === "ETIMEDOUT";
}

function abortReason(signal: AbortSignal, fallback: unknown) {
  if (!signal.aborted) return fallback;
  return signal.reason ?? fallback;
}

async function disposeErrorResponseBody(error: unknown) {
  const body = (error as {
    $response?: {
      body?: {
        destroyed?: boolean;
        readableEnded?: boolean;
        destroy?: () => unknown;
        cancel?: () => Promise<unknown>;
      };
    };
  })?.$response?.body;
  if (!body || body.destroyed || body.readableEnded) return;
  try {
    if (body.destroy) {
      body.destroy();
      return;
    }
    await body.cancel?.();
  } catch {
    // Preserve the authoritative SDK/request error. The transport is already
    // being abandoned, so a secondary cancellation failure has no safer
    // recovery path here.
  }
}

/** Owns one SDK request until its result or streaming body is fully settled. */
export class S3RequestRuntime {
  private readonly idleTimeoutMs: number;
  private readonly taskTimeoutMs: number;

  constructor(options: S3RequestRuntimeOptions) {
    this.idleTimeoutMs = checkedTimeout(
      options.idleTimeoutMs,
      "S3 idle timeout"
    );
    this.taskTimeoutMs = checkedTimeout(
      options.taskTimeoutMs,
      "S3 task timeout"
    );
  }

  async run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: StorageRequestOptions = {},
    responseBody?: (result: T) => Readable | undefined
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const taskController = new AbortController();
    let body: Readable | undefined;
    let taskError: ApiError | undefined;
    const taskTimer = setTimeout(() => {
      taskError = storageTimeout("task");
      taskController.abort(taskError);
      body?.destroy(taskError);
    }, this.taskTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, taskController.signal])
      : taskController.signal;
    let handedOff = false;

    try {
      const result = await work(signal);
      body = responseBody?.(result);
      if (!body) {
        signal.throwIfAborted();
        return result;
      }
      this.handoffBody(body, signal, taskController, taskTimer);
      handedOff = true;
      signal.throwIfAborted();
      return result;
    } catch (error) {
      await disposeErrorResponseBody(error);
      if (options.signal?.aborted) {
        throw abortReason(options.signal, error);
      }
      if (taskController.signal.aborted) {
        throw taskError ?? storageTimeout("task");
      }
      if (isTransportTimeout(error)) {
        throw storageTimeout("transport");
      }
      throw error;
    } finally {
      if (!handedOff) clearTimeout(taskTimer);
    }
  }

  private handoffBody(
    body: Readable,
    signal: AbortSignal,
    taskController: AbortController,
    taskTimer: ReturnType<typeof setTimeout>
  ) {
    const timedBody = body as TimeoutReadable;
    let cleaned = false;
    let fallbackIdleTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(taskTimer);
      if (fallbackIdleTimer) clearTimeout(fallbackIdleTimer);
      signal.removeEventListener("abort", onAbort);
      body.off("readable", resetFallbackIdleTimer);
      body.off("end", cleanup);
      body.off("error", cleanup);
      body.off("close", cleanup);
      timedBody.setTimeout?.(0);
    };
    const destroyWithTimeout = (kind: "idle" | "task") => {
      const error = storageTimeout(kind);
      taskController.abort(error);
      body.destroy(error);
    };
    const resetFallbackIdleTimer = () => {
      if (fallbackIdleTimer) clearTimeout(fallbackIdleTimer);
      fallbackIdleTimer = setTimeout(
        () => destroyWithTimeout("idle"),
        this.idleTimeoutMs
      );
    };
    const onAbort = () => {
      const reason = abortReason(signal, new Error("S3 request aborted"));
      body.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    };

    body.once("end", cleanup);
    body.once("error", cleanup);
    body.once("close", cleanup);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timedBody.setTimeout) {
      timedBody.setTimeout(
        this.idleTimeoutMs,
        () => destroyWithTimeout("idle")
      );
    } else {
      body.on("readable", resetFallbackIdleTimer);
      resetFallbackIdleTimer();
    }
    if (body.destroyed || body.readableEnded) cleanup();
    if (signal.aborted) onAbort();
  }
}
