import type { Hono } from "hono";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import { cspReportPath } from "../core/http/headers.ts";

export function registerSecurityReportRoutes(app: Hono) {
  app.post(cspReportPath, blockCrossSiteFetch, async () => {
    // 接收端只确认投递，不读取正文、不解析 JSON，也不写日志。
    return new Response(null, { status: 204 });
  });
}
