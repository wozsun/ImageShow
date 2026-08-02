import type { Hono } from "hono";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import { cspReportPath } from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";

const maximumDeclaredSecurityReportBytes = 64 * 1024;

async function discardReportBody(request: Request) {
  await request.body?.cancel().catch(() => undefined);
}

export function registerSecurityReportRoutes(app: Hono) {
  app.all(
    cspReportPath,
    async (context, next) => {
      await discardReportBody(context.req.raw);
      return next();
    },
    blockCrossSiteFetch,
    async (context) => {
      if (context.req.method !== "POST") {
        return apiErrorResponse({
          status: 405,
          message: "Method Not Allowed"
        });
      }
      const declaredLength = context.req.header("content-length");
      if (
        declaredLength
        && (
          !/^\d+$/.test(declaredLength)
          || Number(declaredLength) > maximumDeclaredSecurityReportBytes
        )
      ) {
        return apiErrorResponse({
          status: 413,
          code: "request_body_too_large",
          message: "Request body too large"
        });
      }
      // 接收端只确认投递；不解析 JSON，也不写日志、数据库或 Redis。
      return new Response(null, { status: 204 });
    }
  );
}
