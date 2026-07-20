import type { Hono } from "hono";
import { blockCrossSiteFetch, cspReportPath } from "../core/http.ts";

export type SecurityReportReceiver = (request: Request) => void | Promise<void>;

export function registerSecurityReportRoutes(app: Hono, receiver?: SecurityReportReceiver) {
  app.post(cspReportPath, blockCrossSiteFetch, async (c) => {
    // 默认部署只需要一个可用的 Reporting API 目标：不读取正文、不解析 JSON，
    // 也不进行同步日志写入。以后确需观测时，可在应用装配处注入一个有界、
    // 非阻塞的 receiver，将原始请求交给独立队列处理。
    if (receiver) await receiver(c.req.raw);
    return new Response(null, { status: 204 });
  });
}
