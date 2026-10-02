import type { Context } from "hono";
import type { AdminRole } from "@imageshow/shared/browser";

export type AdminSession = {
  id: string;
  username: string;
  csrf: string;
  role: AdminRole;
};

export function adminSessionOf(context: Context): AdminSession {
  const session = context.get("session");
  if (!session) throw new Error("Protected admin route is missing its session middleware");
  return session;
}
