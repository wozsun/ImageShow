import {
  adminPermissions,
  type AdminPermission,
  type AdminRole
} from "@imageshow/shared";
import type { Context, MiddlewareHandler, Next } from "hono";
import { ApiError } from "../core/api-error.ts";

const rolePermissionGrants = {
  super: new Set<AdminPermission>(Object.values(adminPermissions)),
  image: new Set<AdminPermission>()
} satisfies Record<AdminRole, ReadonlySet<AdminPermission>>;

type AdminAuthorizationSession = {
  role?: AdminRole;
};

export function adminPermissionsForRole(
  role: AdminRole
): AdminPermission[] {
  return [...rolePermissionGrants[role]];
}

function adminSessionHasPermission(
  session: AdminAuthorizationSession | undefined,
  permission: AdminPermission
) {
  return session?.role
    ? rolePermissionGrants[session.role].has(permission)
    : false;
}

export function requireAdminPermission(
  permission: AdminPermission
): MiddlewareHandler {
  return async (context, next) => {
    const session = context.get("session") as
      | AdminAuthorizationSession
      | undefined;
    if (!adminSessionHasPermission(session, permission)) {
      throw new ApiError(
        403,
        "forbidden",
        "Permission denied",
        { permission }
      );
    }
    await next();
  };
}

export async function requireSuperAdmin(context: Context, next: Next) {
  const session = context.get("session") as
    | AdminAuthorizationSession
    | undefined;
  if (session?.role !== "super") {
    throw new ApiError(403, "forbidden", "Super admin only");
  }
  await next();
}
