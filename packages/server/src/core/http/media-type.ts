import { MIMEType } from "node:util";

// Node 26.8 API not yet declared by @types/node 26.6.2.
declare module "util" {
  namespace MIMEType {
    function parse(input: string): MIMEType | null;
  }
}

/** Only the media essence participates in HTTP body type policy. */
export function parseHttpMimeType(value: string | null | undefined) {
  const essence = value?.split(";", 1)[0]?.trim() ?? "";
  return MIMEType.parse(essence);
}
