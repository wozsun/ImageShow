import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function importRequestHash(input: {
  mode: string;
  manifest_position?: number | null;
  source_url: string;
  size: number | null;
  storage_slug: string;
  metadata_payload: Record<string, unknown> & { tags?: string[] };
}) {
  const metadataPayload = {
    ...input.metadata_payload,
    ...(input.metadata_payload.tags ? { tags: [...input.metadata_payload.tags].sort() } : {})
  };
  return createHash("sha256").update(stableJson({ ...input, metadata_payload: metadataPayload })).digest("hex");
}
