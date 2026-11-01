import type { Context } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import { requestClientIp, requestLogContext } from "../core/http/request-security.ts";
import { logger } from "../core/logger.ts";
import { reserveRedisWindows } from "../core/redis/window-limit.ts";

// Rejections someone at the login form can cause. Database and Redis outages
// answer 503 and are diagnosed through their own logs.
const loggedLoginFailures: ReadonlySet<string> = new Set([
  "invalid_credentials",
  "too_many_login_attempts",
  "altcha_invalid",
  "altcha_expired",
  "altcha_replayed"
]);

// Under the login limiter's prefix, so Redis checks count it with login failures.
const logBudgetKeyPrefix = "imageshow:login_fail:log";

/**
 * Logs a rejected login. Wrong credentials are always logged: the login
 * limiter already caps how many reach the password check. Proofs are checked
 * before that limiter, so a failed proof costs nothing there, and limited
 * attempts keep answering 429; those share their own per-address and
 * site-wide log budget, sized like the login limits, so they cannot crowd out
 * wrong credentials. Only names of existing accounts are written, so a
 * password typed into the name field stays out of the log. Logging never
 * changes whether the login succeeds.
 */
export async function logAdminLoginFailure(context: Context, username: string, error: unknown) {
  if (!(error instanceof ApiError) || !loggedLoginFailures.has(error.code)) return;
  try {
    if (error.code !== "invalid_credentials") {
      const security = getRuntimeConfig().security;
      const [address, site] = await reserveRedisWindows([
        {
          key: `${logBudgetKeyPrefix}:${requestClientIp(context)}`,
          capacity: security.login_max_failures,
          windowSeconds: security.login_failure_window_seconds
        },
        {
          key: `${logBudgetKeyPrefix}:global`,
          capacity: security.login_global_max_attempts,
          windowSeconds: security.login_global_window_seconds
        }
      ]);
      if (!address!.allowed || !site!.allowed) return;
    }
    const account = await pool.query<{ username: string }>(
      "SELECT username FROM admin_account WHERE username = $1",
      [username]
    );
    logger.warn("admin_login_failed", {
      reason: error.code,
      username: account.rows[0]?.username ?? null,
      ...requestLogContext(context)
    });
  } catch {
    // Without Redis or PostgreSQL the attempt goes unlogged; the login answer stands.
  }
}
