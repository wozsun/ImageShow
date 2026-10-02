import {
  adminPermissions,
  type AdminPermission,
  type AdminRole
} from "@imageshow/shared/browser";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../core/api-error.ts";

const rolePermissionGrants = {
  super: new Set<AdminPermission>(Object.values(adminPermissions)),
  image: new Set<AdminPermission>()
} satisfies Record<AdminRole, ReadonlySet<AdminPermission>>;

export function adminPermissionsForRole(role: AdminRole): AdminPermission[] {
  return [...rolePermissionGrants[role]];
}

export function requireAdminPermission(permission: AdminPermission): MiddlewareHandler {
  return async (context, next) => {
    const session = context.get("session");
    if (!session || !rolePermissionGrants[session.role].has(permission)) {
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
