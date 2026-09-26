import type { ImageVariant, PreparationProfile, PreparedVariantFacts } from "@imageshow/shared/browser";
import type { ProcessIdentity } from "./model.ts";

export type PreparationChildCommand =
  | { id: number; action: "open"; input: string; url: string; expectedSha256?: string; maxBytes: number; maxLongEdge: number; timeoutMs: number; cache: string; profile: PreparationProfile }
  | { id: number; action: "encode"; variant: ImageVariant; candidate: string }
  | { id: number; action: "verify"; path: string }
  | { id: number; action: "close" }
  | { id: number; action: "cancel" };
export type PreparationChildReply = {
  id: number;
  error?: string;
  code?: string;
  identity?: ProcessIdentity;
  input?: { sha256: string; bytes: number };
  facts?: PreparedVariantFacts | Pick<PreparedVariantFacts, "bytes" | "width" | "height" | "md5" | "sha256">;
};
