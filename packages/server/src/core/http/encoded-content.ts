import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { preferredEncodingGroups } from "./accept-encoding.ts";
import type { ContentRepresentation } from "./content-response.ts";
import { logger } from "../logger.ts";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const maxEncodingInputBytes = 1024 * 1024;
const contentEncoders = {
  br: (identity: ContentRepresentation) => brotliAsync(identity.body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: identity.byteLength
    }
  }),
  gzip: (identity: ContentRepresentation) => gzipAsync(identity.body, { level: 9 })
};

type EncodedSnapshot = {
  identity: ContentRepresentation;
  variants: Map<string, ContentRepresentation>;
  started: boolean;
};

/** Keep the current document and at most one encoding job; coalesce newer sources. */
export function createEncodedContentCache(encoders = contentEncoders) {
  let current: EncodedSnapshot | undefined;
  let running = false;

  function encodeCurrent() {
    if (!current || current.started || running) return;
    const snapshot = current;
    snapshot.started = true;
    const { identity } = snapshot;
    if (identity.byteLength > maxEncodingInputBytes) return;
    running = true;
    const encode = async (encoding: keyof typeof contentEncoders) => {
      try {
        const body = await encoders[encoding](identity);
        if (current === snapshot && body.byteLength < identity.byteLength) {
          snapshot.variants.set(encoding, {
            body, byteLength: body.byteLength, etag: identity.etag, encoding
          });
        }
      } catch (error) {
        logger.warn("document encoding failed", { encoding, error });
      }
    };
    void Promise.all([encode("br"), encode("gzip")]).finally(() => {
      running = false;
      encodeCurrent();
    });
  }

  return (identity: ContentRepresentation, acceptEncoding: string | undefined) => {
    if (current?.identity !== identity) {
      current = { identity, variants: new Map(), started: false };
    }
    encodeCurrent();
    // Cold or failed encodings fall back immediately, only if the client allows it.
    for (const group of preferredEncodingGroups(acceptEncoding)) {
      for (const encoding of group.encodings) {
        const representation = current.variants.get(encoding);
        if (representation) return representation;
      }
      if (group.identity) return identity;
    }
    return null;
  };
}
