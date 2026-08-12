import {
  brotliCompress,
  constants as zlibConstants,
  gzip
} from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

export const staticAssetCompression = Object.freeze({
  brotliQuality: 11,
  gzipLevel: 9,
  minimumBytes: 256,
  precompressPattern: /\.(?:js|css|html|svg|json|xml|txt|webmanifest)$/
});

export function staticAssetIsCompressible(fileName) {
  return staticAssetCompression.precompressPattern.test(fileName)
    && !/\.(?:br|gz)$/.test(fileName);
}

export async function compressStaticAsset(fileName, source) {
  const rawBytes = source.length;
  if (
    rawBytes < staticAssetCompression.minimumBytes
    || !staticAssetIsCompressible(fileName)
  ) {
    return {
      rawBytes,
      gzipBytes: rawBytes,
      brotliBytes: rawBytes,
      effectiveBytes: rawBytes,
      gzip: null,
      brotli: null
    };
  }

  const [brotliCandidate, gzipCandidate] = await Promise.all([
    brotliAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]:
          staticAssetCompression.brotliQuality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: rawBytes
      }
    }),
    gzipAsync(source, { level: staticAssetCompression.gzipLevel })
  ]);
  const brotli = brotliCandidate.length < rawBytes ? brotliCandidate : null;
  const gzipped = gzipCandidate.length < rawBytes ? gzipCandidate : null;
  const brotliBytes = brotli?.length ?? rawBytes;
  const gzipBytes = gzipped?.length ?? rawBytes;
  return {
    rawBytes,
    gzipBytes,
    brotliBytes,
    effectiveBytes: Math.min(rawBytes, gzipBytes, brotliBytes),
    gzip: gzipped,
    brotli
  };
}
