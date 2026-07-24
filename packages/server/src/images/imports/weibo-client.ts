import { runWeiboRequestWithinGlobalLimit } from "./weibo-request-limiter.ts";
import {
  WeiboImportError,
  type WeiboImportErrorCode
} from "./weibo-types.ts";
import { asRecord, scalarString } from "./weibo-values.ts";

const weiboUserAgent = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/136.0.0.0 Safari/537.36"
].join(" ");
const weiboRequestTimeoutMs = 15_000;
const weiboVisitorResponseMaxBytes = 64 * 1024;
const weiboStatusResponseMaxBytes = 4 * 1024 * 1024;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseCallbackJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      "微博访客接口返回了无法识别的数据"
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      "微博访客接口返回了无效数据"
    );
  }
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  let rejectForAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectForAbort, { once: true });
    if (signal.aborted) rejectForAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (rejectForAbort) signal.removeEventListener("abort", rejectForAbort);
  }
}

function responseLimitLabel(maxBytes: number) {
  return maxBytes % (1024 * 1024) === 0
    ? `${maxBytes / (1024 * 1024)} MiB`
    : `${maxBytes / 1024} KiB`;
}

async function readWeiboResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  context: string
) {
  signal.throwIfAborted();
  const tooLarge = () => new WeiboImportError(
    "weibo_response_too_large",
    `${context}：响应正文超过 ${responseLimitLabel(maxBytes)} 安全上限`
  );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestAndParseWeiboResponse<Result>(
  input: string | URL,
  init: RequestInit,
  code: Extract<
    WeiboImportErrorCode,
    "weibo_visitor_failed" | "weibo_request_failed"
  >,
  context: string,
  maxResponseBytes: number,
  parseResponse: (response: Response, text: string) => Result
) {
  const callerSignal = init.signal ?? undefined;
  try {
    return await runWeiboRequestWithinGlobalLimit(callerSignal, async () => {
      const timeoutSignal = AbortSignal.timeout(weiboRequestTimeoutMs);
      const requestSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(input, {
        ...init,
        signal: requestSignal
      });
      const text = await readWeiboResponseText(
        response,
        maxResponseBytes,
        requestSignal,
        context
      );
      return parseResponse(response, text);
    });
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    if (error instanceof WeiboImportError) throw error;
    throw new WeiboImportError(code, `${context}：${errorMessage(error)}`);
  }
}

export async function createWeiboVisitorCookie(signal?: AbortSignal) {
  const fingerprint = JSON.stringify({
    os: "1",
    browser: "Chrome136,0,0,0",
    fonts: "undefined",
    screenInfo: "1920*1080*24",
    plugins: ""
  });
  const commonHeaders = {
    "user-agent": weiboUserAgent,
    referer: "https://passport.weibo.com/"
  };
  const generated = await requestAndParseWeiboResponse(
    "https://passport.weibo.com/visitor/genvisitor",
    {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ cb: "gen_callback", fp: fingerprint }),
      signal
    },
    "weibo_visitor_failed",
    "初始化微博访客身份失败",
    weiboVisitorResponseMaxBytes,
    (response, text) => ({
      response,
      data: asRecord(parseCallbackJson(text))
    })
  );
  const generatedPayload = asRecord(generated.data?.data);
  const tid = scalarString(generatedPayload?.tid);
  if (
    !generated.response.ok
    || Number(generated.data?.retcode) !== 20_000_000
    || !tid
  ) {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      `初始化微博访客身份失败：${scalarString(generated.data?.msg) || generated.response.status}`
    );
  }

  const incarnateUrl = new URL(
    "https://passport.weibo.com/visitor/visitor"
  );
  const incarnateParameters = {
    a: "incarnate",
    t: tid,
    w: "2",
    c: "095",
    gc: "",
    cb: "cross_domain",
    from: "weibo",
    _rand: String(Math.random())
  };
  for (const [name, parameter] of Object.entries(incarnateParameters)) {
    incarnateUrl.searchParams.set(name, parameter);
  }

  const incarnated = await requestAndParseWeiboResponse(
    incarnateUrl,
    { headers: commonHeaders, redirect: "manual", signal },
    "weibo_visitor_failed",
    "获取微博访客身份失败",
    weiboVisitorResponseMaxBytes,
    (response, text) => ({
      response,
      data: asRecord(parseCallbackJson(text))
    })
  );
  const identityPayload = asRecord(incarnated.data?.data);
  const sub = scalarString(identityPayload?.sub);
  const subp = scalarString(identityPayload?.subp);
  if (
    !incarnated.response.ok
    || Number(incarnated.data?.retcode) !== 20_000_000
    || !sub
    || !subp
  ) {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      `获取微博访客身份失败：${scalarString(incarnated.data?.msg) || incarnated.response.status}`
    );
  }

  return `SUB=${sub}; SUBP=${subp}`;
}

export async function fetchWeiboStatus(
  identifier: string,
  cookie: string,
  signal?: AbortSignal
) {
  const endpoint = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(identifier)}`;
  return requestAndParseWeiboResponse(
    endpoint,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://weibo.com/",
        "user-agent": weiboUserAgent,
        "x-requested-with": "XMLHttpRequest",
        cookie
      },
      redirect: "manual",
      signal
    },
    "weibo_request_failed",
    "请求微博失败",
    weiboStatusResponseMaxBytes,
    (response, text) => {
      const location = response.headers.get("location") ?? "";
      if (response.status >= 300 && response.status < 400) {
        const message = /passport\.weibo\.(com|cn)/.test(location)
          ? "微博要求登录验证，当前仅支持无需登录即可访问的公开微博"
          : `微博接口返回重定向：${location || response.status}`;
        throw new WeiboImportError("weibo_post_unavailable", message);
      }
      if (!response.ok) {
        throw new WeiboImportError(
          "weibo_request_failed",
          `微博接口返回 HTTP ${response.status}`
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new WeiboImportError(
          "weibo_request_failed",
          "微博没有返回 JSON，可能触发了登录验证或访问限制"
        );
      }
    }
  );
}
