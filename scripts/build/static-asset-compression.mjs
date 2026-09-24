import {
  brotliCompress,
  constants as zlibConstants,
  gzip,
  zstdCompress
} from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const zstdAsync = promisify(zstdCompress);

export const staticAssetCompression = Object.freeze({
  brotliQuality: 11,
  gzipLevel: 9,
  zstdLevel: 22,
  zstdWindowLog: 23,
  precompressPattern: /\.(?:js|css|html|svg|json|xml|txt|webmanifest)$/
});

export function staticAssetIsCompressible(fileName) {
  return (
    staticAssetCompression.precompressPattern.test(fileName)
      && !/\.(?:br|zst|gz)$/.test(fileName)
  );
}

function compressionResult(rawBytes, { brotli = null, zstd = null, gzip = null } = {}) {
  const brotliBytes = brotli?.length ?? rawBytes;
  const zstdBytes = zstd?.length ?? rawBytes;
  const gzipBytes = gzip?.length ?? rawBytes;
  // The minimum is a size-analysis bound, not the bytes selected by negotiation.
  const defaultEncoding = brotli ? "br" : zstd ? "zstd" : gzip ? "gzip" : "identity";
  return {
    rawBytes,
    gzipBytes,
    brotliBytes,
    zstdBytes,
    effectiveBytes: Math.min(rawBytes, gzipBytes, brotliBytes, zstdBytes),
    defaultEncoding,
    defaultBytes: (brotli ?? zstd ?? gzip)?.length ?? rawBytes,
    gzip,
    brotli,
    zstd
  };
}

export async function compressStaticAsset(fileName, source) {
  const rawBytes = source.length;
  if (!staticAssetIsCompressible(fileName)) {
    return compressionResult(rawBytes);
  }

  const [brotliCandidate, zstdCandidate, gzipCandidate] = await Promise.all([
    brotliAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: staticAssetCompression.brotliQuality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: rawBytes
      }
    }),
    zstdAsync(source, {
      pledgedSrcSize: rawBytes,
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: staticAssetCompression.zstdLevel,
        // RFC 9659: HTTP zstd frames must require at most an 8 MiB window.
        [zlibConstants.ZSTD_c_windowLog]: staticAssetCompression.zstdWindowLog
      }
    }),
    gzipAsync(source, { level: staticAssetCompression.gzipLevel })
  ]);
  return compressionResult(rawBytes, {
    brotli: brotliCandidate.length < rawBytes ? brotliCandidate : null,
    zstd: zstdCandidate.length < rawBytes ? zstdCandidate : null,
    gzip: gzipCandidate.length < rawBytes ? gzipCandidate : null
  });
}
