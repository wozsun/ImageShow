import type { AdminRole, LogLevel } from "./common.ts";
import type { AdminImageDetailItemDto } from "./images.ts";

export type AdvancedConfigBackendPreviewDto = {
  slug: string;
  display_name: string;
  type: "s3" | "webdav";
  enabled: boolean;
  is_default: boolean;
};

export type AdvancedConfigPreviewDto = {
  format: "imageshow-config";
  format_version: number;
  application_version: string;
  exported_at: string;
  config_groups: number;
  storage_backends: AdvancedConfigBackendPreviewDto[];
  conflicts: string[];
  existing_slugs: string[];
};

export type AdvancedConfigPreviewResponseDto = {
  preview: AdvancedConfigPreviewDto;
};

export type AdminUserDto = {
  username: string;
  role: AdminRole;
};

export type AdminUsersResponseDto = {
  items: AdminUserDto[];
};

export type LogFileSummaryDto = {
  name: string;
  size: number;
  modified_at: string;
};

export type AdminLogPayloadDto = {
  level: LogLevel;
  files: LogFileSummaryDto[];
  selected: string;
  limit_bytes: number;
  content: string;
  truncated: boolean;
  bytes_read: number;
};

export type AdminLogLevelDto = {
  level: LogLevel;
};

export type AdminOverviewDto = {
  gallery: number;
  theme_unset: number;
  trash: number;
  total: number;
  local: number;
  nonlocal: number;
  local_image_size: number;
  local_thumb_size: number;
  nonlocal_image_size: number;
  nonlocal_thumb_size: number;
  theme_count: number;
  backend_count: number;
  pc: number;
  mb: number;
  dark: number;
  light: number;
  top_themes: Array<{ theme: string; count: number }>;
  recent: AdminImageDetailItemDto[];
};
