import { imageVariants, type ImageVariant, type ImageVariantsDto } from "@imageshow/shared/browser";

const imageVariantColumnPrefixes = { large: "l", medium: "m", small: "s" } as const;

type DatabaseNumber = number | string;
export type ImageVariantRecord = Record<"l_width" | "l_height" | "l_byte_size" | "m_width" | "m_height" | "m_byte_size" | "s_width" | "s_height" | "s_byte_size", DatabaseNumber>
  & Record<"l_md5" | "m_md5" | "s_md5", string>;

export const imageVariantColumns = imageVariants.flatMap((variant) =>
  ["width", "height", "byte_size", "md5"].map((field) => `${imageVariantColumnPrefixes[variant]}_${field}`)
).join(", ");

export function storedVariantFacts(row: ImageVariantRecord, variant: ImageVariant) {
  const prefix = imageVariantColumnPrefixes[variant];
  return {
    width: Number(row[`${prefix}_width`]),
    height: Number(row[`${prefix}_height`]),
    byte_size: Number(row[`${prefix}_byte_size`]),
    md5: row[`${prefix}_md5`]
  };
}

export function presentImageVariants(row: ImageVariantRecord): ImageVariantsDto {
  const dimensions = (variant: ImageVariant) => {
    const { md5: _md5, ...value } = storedVariantFacts(row, variant);
    return value;
  };
  return { large: dimensions("large"), medium: dimensions("medium"), small: dimensions("small") };
}
