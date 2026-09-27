export const imageVariants = ["large", "medium", "small"] as const;
export type ImageVariant = (typeof imageVariants)[number];

export type ImageVariantDimensions = { width: number; height: number; byte_size: number };
export type ImageVariantsDto = Record<ImageVariant, ImageVariantDimensions>;
export type BoundImageAddress = { id: string; base_url: string };

export function imageVariantUrl(image: BoundImageAddress, variant: ImageVariant) {
  return `${image.base_url}/${variant}/${image.id.slice(-2)}/${image.id}.webp`;
}

export type VariantSettings = {
  quality: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
};
export type NormalizeProfile = Record<ImageVariant, VariantSettings> & { quality_step: number };
export const variantSettingLimits = {
  large: { max_long_edge: [512, 16000], max_size_kb: [256, 5120] },
  medium: { max_long_edge: [256, 8000], max_size_kb: [128, 2560] },
  small: { max_long_edge: [128, 2000], max_size_kb: [8, 1280] }
} as const;

export function defaultNormalizeProfile(): NormalizeProfile {
  const common = { quality: 80, min_quality: 60 };
  return {
    quality_step: 5,
    large: { ...common, max_long_edge: 4200, max_size_kb: 700 },
    medium: { ...common, max_long_edge: 2200, max_size_kb: 350 },
    small: { ...common, max_long_edge: 600, max_size_kb: 60 }
  };
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
