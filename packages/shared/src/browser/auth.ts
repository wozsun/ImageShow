import type { AdminPreferences } from "./admin.ts";
import type { SiteVersionSettings } from "./settings.ts";

export const altchaSolveTimeoutMs = 60_000;

export type AdminRole = "super" | "image";

export const adminPermissions = {
  logsManage: "logs.manage",
  usersManage: "users.manage",
  settingsManage: "settings.manage",
  storageManage: "storage.manage",
  imageStorageMigrate: "image.storage.migrate",
  imageTrashPurge: "image.trash.purge",
  tagDelete: "tag.delete",
  groupDelete: "group.delete",
  themeDelete: "theme.delete",
  authorDelete: "author.delete",
  storageMaintenanceMigrate: "storage.maintenance.migrate",
  storageMaintenanceExecute: "storage.maintenance.execute",
  cacheMaintenanceRebuild: "cache.maintenance.rebuild"
} as const;

export type AdminPermission = (typeof adminPermissions)[keyof typeof adminPermissions];

export type AuthStateDto =
  | {
      authenticated: false;
      altcha_enabled: boolean;
      login_background: string;
    }
  | {
      authenticated: true;
      username: string;
      role: AdminRole;
      permissions: AdminPermission[];
      csrf_token: string;
      application_version: string;
      preferences: AdminPreferences;
      preferences_etag: string;
      version_settings: SiteVersionSettings;
    };

export type AdminLoginResultDto = {
  csrf_token: string;
};

export type AdminUserDto = {
  username: string;
  role: AdminRole;
};

export type AdminUsersResponseDto = {
  items: AdminUserDto[];
};
