import { z } from "zod";
import {
  adminPreferenceValueOptions,
  adminPreferencesMaxBytes
} from "@imageshow/shared/browser";
import {
  adminPasswordInput,
  adminUsernameInput
} from "../../users/credentials.ts";

export const userCreateInput = z.strictObject({
  username: adminUsernameInput,
  password: adminPasswordInput
});

export const userPasswordInput = z.strictObject({
  password: adminPasswordInput
});

export const passwordChangeInput = z.strictObject({
  current_password: z.string().min(1).max(128),
  new_password: adminPasswordInput
});

const adminPreferenceInputFields = {
  color_scheme: z.enum(adminPreferenceValueOptions.color_scheme).optional(),
  image_sort_by: z.enum(adminPreferenceValueOptions.image_sort_by).optional(),
  image_sort_order: z.enum(adminPreferenceValueOptions.image_sort_order).optional(),
  image_thumbnail_fit: z.enum(adminPreferenceValueOptions.image_thumbnail_fit).optional(),
  theme_view_mode: z.enum(adminPreferenceValueOptions.theme_view_mode).optional(),
  tag_view_mode: z.enum(adminPreferenceValueOptions.tag_view_mode).optional(),
  author_view_mode: z.enum(adminPreferenceValueOptions.author_view_mode).optional()
} satisfies Record<keyof typeof adminPreferenceValueOptions, z.ZodType>;

export const adminPreferencesInput = z
  .strictObject(adminPreferenceInputFields)
  .refine(
    (value) => Object.values(value).some((preference) => preference !== undefined),
    "至少需要提供一项管理端偏好"
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= adminPreferencesMaxBytes,
    "管理端偏好过大"
  );
