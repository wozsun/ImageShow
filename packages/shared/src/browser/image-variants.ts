export const imageVariants = ["large", "medium", "small"] as const;
export type ImageVariant = (typeof imageVariants)[number];

type ImageVariantDimensions = { width: number; height: number; byte_size: number };
export type ImageVariantsDto = Record<ImageVariant, ImageVariantDimensions>;
export type ImageVariantByteSizesDto = Record<ImageVariant, Pick<ImageVariantDimensions, "byte_size">>;
export type BoundImageAddress = { id: string; base_url: string };

/** Stable physical identity, independent of editable image classification. */
export function storageObjectKey(id: string) {
  return `${id.slice(-2)}/${id}.webp`;
}

export function imageVariantUrl(image: BoundImageAddress, variant: ImageVariant) {
  return `${image.base_url}/${variant}/${storageObjectKey(image.id)}`;
}

export type VariantSettings = {
  quality: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
};
export type NormalizeProfile = Record<ImageVariant, VariantSettings> & { quality_step: number };
const variantQualityLimits = { quality: [50, 100], min_quality: [1, 80] } as const;
export const variantSettingLimits = {
  large: { ...variantQualityLimits, max_long_edge: [512, 16000], max_size_kb: [256, 5120] },
  medium: { ...variantQualityLimits, max_long_edge: [256, 8000], max_size_kb: [128, 2560] },
  small: { ...variantQualityLimits, max_long_edge: [128, 2000], max_size_kb: [8, 1280] }
} as const;
