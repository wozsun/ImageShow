import { z } from "zod";
import { adminImagePageLimit, appConfig, categoryKey, slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { ApiError } from "./http.js";

// An optional http(s) URL field (原图 URL, 作者主页链接) that's rendered as an <a href>. A pasted
// value without a scheme — e.g. "example.com/x.jpg" — is forgiving-normalized to https:// so it
// still saves as a working link instead of failing validation; whatever isn't a valid http(s)
// URL after that is rejected. Empty stays empty ("not set").
function httpUrlField(message: string) {
  return z.string().trim().max(2048).default("")
    .transform((value) => {
      // Empty, or already carries a scheme (http://, https://, ftp://, …): leave as-is. Only a
      // bare scheme-less host/path gets https:// prepended.
      if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
      return `https://${value}`;
    })
    .refine((value) => {
      if (value === "") return true;
      try {
        const parsed = new URL(value);
        // Must be an http(s) link with a sane hostname. URL parsing is lenient (it would keep
        // "ht!tp" as a host), so also require the host to be plain domain/IP characters — IDN
        // hosts are already punycode (xn--…, still within [a-z0-9.-]) by this point.
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
          && /^[a-z0-9.-]+$/.test(parsed.hostname);
      } catch {
        return false;
      }
    }, message);
}

const metadataInput = z.object({
  // device is always concrete (pc/mb) — derived from aspect ratio at the source (browser
  // for uploads, server for link imports); there is no "unset" device. brightness is
  // overridden by the upload/edit/link inputs below to also accept the transient "auto".
  device: z.enum(appConfig.devices),
  brightness: z.enum(appConfig.brightness),
  theme: z.string().trim().toLowerCase().min(1).max(appConfig.themeMaxLength).regex(slugPattern).default("none"),
  // A single, optional author slug. Unlike theme it's nullable (no 'none' sentinel) and
  // doesn't take part in category keys — a plain attribution field. "" means "no author"
  // (the default and what the write paths store as NULL); otherwise a valid slug.
  author: z.string().trim().toLowerCase().max(32)
    .refine((value) => value === "" || slugPattern.test(value), "author must be a lowercase slug")
    .default(""),
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(2000).default(""),
  source: z.string().trim().max(2048).default(""),
  // 原图 URL: a direct link to the full-resolution original (forgiving-normalized — see httpUrlField).
  original: httpUrlField("原图 URL 需为有效的 http(s) 链接")
});

// The image edit / batch-edit update. Every metadata field is optional (only the
// changed ones are sent); brightness additionally accepts the transient value "auto"
// (re-detect light/dark from the stored object, overwriting the current value).
export const metadataUpdateInput = metadataInput.partial().extend({
  brightness: z.enum(["dark", "light", "auto"]).optional()
});

export const md5Input = z.object({
  md5: z.string().trim().toLowerCase().regex(/^[a-f0-9]{32}$/)
});

// Tags and themes share one shape. Slugs are lowercase ASCII (URL-safe, match
// metadata.theme), <=32 chars. display_name may be any text (incl. Chinese) and
// also resolves back to the slug in search.
const slugInput = z.string().trim().toLowerCase()
  .min(1, "标识 slug 不能为空")
  .max(32, "标识 slug 最长 32 个字符")
  .regex(slugPattern, "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const displayNameInput = z.string().trim().max(64, "显示名最长 64 个字符");

export const tagSlugInput = slugInput;
export const tagCreateInput = z.object({ slug: tagSlugInput, display_name: displayNameInput.optional().default("") });
export const tagDisplayUpdateInput = z.object({ display_name: displayNameInput.default("") });

export const imageTagsInput = z.object({
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])])
});

export const themeSlugInput = slugInput;
const themeDisplayInput = displayNameInput;

// A list of theme/tag slugs (deduped, order preserved) for batch delete and manual
// reorder. Both vocabularies share the same slug shape.
export const slugListInput = z.object({
  slugs: z.array(slugInput).min(1).max(2000).transform((slugs) => [...new Set(slugs)])
});
export const themeCreateInput = z.object({ slug: themeSlugInput, display_name: themeDisplayInput.optional().default("") });
export const themeDisplayUpdateInput = z.object({ display_name: themeDisplayInput.default("") });

// Authors share the theme/tag slug + display_name shape, plus an optional http(s) link to the
// author's page — forgiving-normalized like an image's 原图 URL (see httpUrlField).
export const authorSlugInput = slugInput;
const authorLinkInput = httpUrlField("作者主页链接需为有效的 http(s) 链接");
export const authorCreateInput = z.object({ slug: authorSlugInput, display_name: displayNameInput.optional().default(""), link: authorLinkInput });
export const authorMetaUpdateInput = z.object({ display_name: displayNameInput.default(""), link: authorLinkInput });

export const uuidInput = z.string().uuid();

// Admin accounts. Usernames follow the same slug rule as theme/tag/author slugs (lowercase
// a-z0-9 with internal hyphens, 1–32 chars), so the create-user form reuses that field's
// format / validation / hint. Passwords are stored hashed (argon2); the policy is a length
// floor of 8 plus at least one letter and one digit.
export const adminUsernameInput = z.string().trim().toLowerCase()
  .min(1, "用户名不能为空")
  .max(32, "用户名最长 32 个字符")
  .regex(slugPattern, "用户名只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");
const adminPasswordInput = z.string().min(8).max(128)
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "密码至少 8 位，且需同时包含字母和数字");
export const userCreateInput = z.object({ username: adminUsernameInput, password: adminPasswordInput });
export const userPasswordInput = z.object({ password: adminPasswordInput });
// Self-service password change: the current password (verified, no policy re-check) plus the
// new one (full policy). Any logged-in admin may change their own password.
export const passwordChangeInput = z.object({
  current_password: z.string().min(1).max(128),
  new_password: adminPasswordInput
});

export const imageIdsInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)])
});

// A storage backend slug (references storage_backend.slug; same slug shape as tags/themes).
export const storageSlugInput = slugInput;

export const batchMigrateStorageInput = z.object({
  ids: z.array(uuidInput).min(1).max(200).transform((ids) => [...new Set(ids)]),
  target: storageSlugInput
});

export const uploadCreateInput = metadataInput.extend({
  // Upload accepts the transient "auto" (detect light/dark from the thumbnail at finalize),
  // which is the default. There is no "unset" brightness — every image is classified.
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  // Only size + md5 are declared, to verify the uploaded bytes at finalize. The real
  // ext / width / height all come from the server probe, so the client never sends them;
  // the filename is a browser-side form-fill helper and likewise never reaches the server.
  size: z.number().int().positive(),
  md5: md5Input.shape.md5,
  idempotency_key: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
  storage_slug: storageSlugInput.optional()
});

// Link import is a two-phase flow. prepare downloads one URL, builds a thumbnail and stages
// it server-side (no row yet); commit takes that staged id plus the card-edited metadata and
// writes the thumbnail to the chosen backend as an is_link row (object_key = the URL).
export const linkPrepareInput = z.object({ url: z.string().trim().url().max(2048) });

export const linkCommitInput = metadataInput.extend({
  // Mirrors uploadCreateInput: accepts the transient "auto" (re-detect from the staged
  // thumbnail at commit), the default.
  brightness: z.enum(["dark", "light", "auto"]).default("auto"),
  staging_id: z.string().uuid(),
  tags: z.array(tagSlugInput).max(50).optional().transform((tags) => [...new Set(tags ?? [])]),
  // Backend the generated thumbnail is stored in (the original is only linked). A slug
  // referencing storage_backend; defaults to the built-in local backend.
  storage_slug: storageSlugInput.optional().default("local")
});

// Shared shape for the cursor-paginated image lists. Both the public gallery and
// the admin list page through (created_at, id) via an opaque `cursor`.
const imageListBase = z.object({
  status: z.enum(["ready", "deleted"]).default("ready"),
  d: z.enum(appConfig.devices).optional(),
  b: z.enum(appConfig.brightness).optional(),
  t: z.string().trim().toLowerCase().max(1024).optional(),
  // Tag filter: comma-separated selectors, each optionally `!`-prefixed to exclude.
  // Resolved through slug/display_name like `t`. Include is OR (any selected tag).
  tag: z.string().trim().toLowerCase().max(1024).optional(),
  // Author filter: comma-separated selectors, each optionally `!`-prefixed to exclude.
  // Resolved through slug/display_name like `t`. An image has one author, so include is IN.
  a: z.string().trim().toLowerCase().max(1024).optional(),
  cursor: z.string().trim().min(1).max(512).optional()
});

export const listQuery = imageListBase.extend({
  // The public gallery is ready-only; deleted images are admin-only (the admin list uses
  // adminImageListQuery, which keeps both statuses). Narrow the shared base's status enum to
  // the single literal so an unauthenticated ?status=deleted can't enumerate the recycle bin —
  // it's rejected as a validation error instead of returning trashed images.
  status: z.literal("ready").default("ready"),
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).optional(),
  // When set, shuffle the items within each loaded page. Applied on egress only, so
  // the keyset cursor still pages over the stable (created_at, id) order.
  shuffle: z.enum(["1", "true"]).optional().transform(Boolean)
});

export const adminImageListQuery = imageListBase.extend({
  limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).default(adminImagePageLimit)
});

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Surface the actual reason(s) — the zod messages, Chinese where we've set them — as the
    // error text instead of a generic "Validation failed", so the UI can show why it failed.
    // The full per-field map still rides along in `details`.
    const flat = result.error.flatten();
    const messages = [...flat.formErrors, ...Object.values(flat.fieldErrors).flatMap((errs) => errs ?? [])];
    const detail = [...new Set(messages)].join("；") || "请求参数有误";
    throw new ApiError(400, "validation_error", detail, flat);
  }
  return result.data;
}

export function normalizedCategory(input: { device: Device; brightness: Brightness; theme: string }) {
  return categoryKey(input.device, input.brightness, input.theme || "none");
}
