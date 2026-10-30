import { adminImageBatchLimit } from "./admin.ts";
import { altchaSolveTimeoutMs } from "./auth.ts";
import { randomQueryLimits } from "./random-limits.ts";

type NumberLimit = Readonly<{ min: number; max: number; exclusiveMin?: true }>;
type TextLimit = Readonly<{ maxLength: number }>;
type ListLimit = Readonly<{ maxItems: number; maxItemLength?: number; maxSerializedLength?: number }>;

export const publicBaseUrlMaxLength = 2048;

// 嵌入来源与页面脚本来源两份 CSP 来源列表共用。
const cspHostSourceListLimit = { maxItems: 32, maxItemLength: 320, maxSerializedLength: 4_096 } as const;

/**
 * RuntimeConfig 字段的取值范围，服务端校验与后台表单共用这一份。数值为闭区间，exclusiveMin 表示下限本身不可取；列表限制项数，CSP 来源列表另限单项与序列化后的总长度；三档图片的质量、长边与体积见 variantSettingLimits。
 */
export const runtimeConfigLimits = {
  "site.domain": { maxLength: 259 },
  "site.additional_domains": { maxItems: 32 },
  "site.icon": { maxLength: 2048 },
  "site.description": { maxLength: 200 },
  "site.assets_base_url": { maxLength: publicBaseUrlMaxLength },
  "site.script_sources": cspHostSourceListLimit,
  "site.home.background": { maxLength: 2048 },
  "site.home.banner_label": { maxLength: 160 },
  "site.home.banner_title": { maxLength: 80 },
  "site.show.drift_speed": { min: 10, max: 60 },
  "site.random_max_items": { min: 1, max: randomQueryLimits.maxJsonItems },
  "site.icp": { maxLength: 200 },
  "site.mps": { maxLength: 200 },
  "site.footer": { maxLength: 2000 },
  "embed.allowed_origins": cspHostSourceListLimit,
  "ingestion.max_file_size_mb": { min: 0, max: 200, exclusiveMin: true },
  "ingestion.max_long_edge": { min: 300, max: 32_000 },
  "ingestion.list_page_size": { min: 1, max: 100 },
  "ingestion.commit_concurrency": { min: 1, max: 16 },
  "upload.max_items": { min: 1, max: 1_000 },
  "upload.browser_concurrency": { min: 1, max: 8 },
  "upload.raw_concurrency": { min: 1, max: 8 },
  "import.fetch_timeout_seconds": { min: 5, max: 300 },
  "import.max_items": { min: 1, max: 1_000 },
  "weibo.max_items": { min: 1, max: 50 },
  "weibo.request_delay_seconds": { min: 0, max: 60 },
  "normalize.concurrency": { min: 1, max: 8 },
  "normalize.quality_step": { min: 1, max: 20 },
  "admin.login_background": { maxLength: 2048 },
  "admin.image_page_size": { min: 10, max: adminImageBatchLimit },
  "admin.recent_uploads": { min: 1, max: 60 },
  "security.session_ttl_seconds": { min: 5 * 60, max: 365 * 24 * 60 * 60 },
  "security.login_failure_window_seconds": { min: 30, max: 300 },
  "security.login_max_failures": { min: 3, max: 500 },
  "security.login_global_window_seconds": { min: 60, max: 600 },
  "security.login_global_max_attempts": { min: 5, max: 1_000 },
  "security.random_window_seconds": { min: 1, max: 3_600 },
  "security.random_max_requests": { min: 1, max: 10_000 },
  "security.random_limit_max_requests": { min: 1, max: 10_000 },
  // 挑战有效期覆盖完整求解时间，另留 30 秒提交余量。
  "altcha.ttl_seconds": { min: Math.ceil(altchaSolveTimeoutMs / 1000) + 30, max: 60 * 60 },
  "altcha.cost": { min: 1_000, max: 100_000 },
  "altcha.counter_range": { min: 100, max: 100_000 },
  "log.max_size_mb": { min: 0, max: 1_024, exclusiveMin: true },
  "log.max_files": { min: 1, max: 100 }
} as const satisfies Record<string, NumberLimit | TextLimit | ListLimit>;
