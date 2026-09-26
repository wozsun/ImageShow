export const imageVariants = ["large", "middle", "small"] as const;
export type ImageVariant = (typeof imageVariants)[number];
export const imageVariantDirectories = { large: "l", middle: "m", small: "s" } as const;

export type VariantSettings = {
  quality: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
  webp_effort: number;
};
export type PreparationProfile = Record<ImageVariant, VariantSettings> & { quality_step: number };
export const variantSettingLimits = {
  large: { max_long_edge: [512, 16000], max_size_kb: [256, 5120] },
  middle: { max_long_edge: [256, 8000], max_size_kb: [128, 2560] },
  small: { max_long_edge: [128, 2000], max_size_kb: [8, 1280] }
} as const;

export function defaultPreparationProfile(): PreparationProfile {
  const common = { quality: 80, min_quality: 60, webp_effort: 4 };
  return {
    quality_step: 5,
    large: { ...common, max_long_edge: 4200, max_size_kb: 700 },
    middle: { ...common, max_long_edge: 2200, max_size_kb: 350 },
    small: { ...common, max_long_edge: 600, max_size_kb: 60 }
  };
}

export function parsePreparationProfile(input: unknown): PreparationProfile {
  const object = (value: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error(`${path} 包含未知字段`);
    return record;
  };
  const integer = (value: unknown, min: number, max: number, path: string) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${path} 必须是 ${min}–${max} 的整数`);
    }
    return value;
  };
  const root = object(input, [...imageVariants, "quality_step"], "profile");
  const profile = defaultPreparationProfile();
  profile.quality_step = integer(root.quality_step, 1, 20, "quality_step");
  for (const variant of imageVariants) {
    const row = object(root[variant], Object.keys(profile[variant]), variant);
    const limits = variantSettingLimits[variant];
    profile[variant] = {
      quality: integer(row.quality, 50, 100, `${variant}.quality`),
      min_quality: integer(row.min_quality, 1, 80, `${variant}.min_quality`),
      max_long_edge: integer(row.max_long_edge, limits.max_long_edge[0], limits.max_long_edge[1], `${variant}.max_long_edge`),
      max_size_kb: integer(row.max_size_kb, limits.max_size_kb[0], limits.max_size_kb[1], `${variant}.max_size_kb`),
      webp_effort: integer(row.webp_effort, 0, 6, `${variant}.webp_effort`)
    };
    if (profile[variant].min_quality > profile[variant].quality) throw new Error(`${variant} 最低质量不能超过初始质量`);
  }
  for (const key of ["max_long_edge", "max_size_kb"] as const) {
    if (profile.small[key] > profile.middle[key] || profile.middle[key] > profile.large[key]) {
      throw new Error(`${key} 必须满足 small ≤ middle ≤ large`);
    }
  }
  return profile;
}

export type PreparedVariantFacts = {
  bytes: number;
  width: number;
  height: number;
  md5: string;
  sha256: string;
  quality: number | null;
  effort: number | null;
  passthrough: boolean;
  over_target: boolean;
};
export type PreparationState = "pending" | "running" | "ready" | "failed" | "stale" | "excluded";
export type PreparationMode = "generate" | "verify";
export type PreparationAction = "start" | "stop" | "verify" | "retry" | "reconcile" | "set-concurrency";
export type PreparationControl = {
  action: PreparationAction;
  revision: number;
  profile?: PreparationProfile;
  concurrency?: number;
};
export type PreparationItemDto = {
  image_id: string;
  title: string;
  state: PreparationState;
  phase: string;
  error: string;
  retries: number;
  updated_at: string;
  variants: Partial<Record<ImageVariant, PreparedVariantFacts>>;
};
export type PreparationStatusDto = {
  run_id: string | null;
  profile: PreparationProfile;
  revision: number;
  mode: PreparationMode;
  desired_state: "running" | "stopped";
  state: string;
  concurrency: number;
  block: string | null;
  completed_attempts: number;
  rest: { kind: "short" | "long"; seconds: number; deadline: string | null } | null;
  server_time: string;
  total: number;
  untracked: number;
  deletion_pending: number;
  variant_counts: Record<ImageVariant, number>;
  counts: Record<PreparationState, number>;
  active: PreparationItemDto[];
  items: PreparationItemDto[];
  page: number;
  pages: number;
  verified_at: string | null;
};
