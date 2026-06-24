import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { appConfig } from "@imageshow/shared";
import { getStorageConfig } from "../config/settings.js";
import { storageConfigForBackend, storageS3Client, storageS3ObjectName } from "./storage.js";

export async function checkS3Cors(origin: string) {
  const config = storageConfigForBackend(await getStorageConfig(), "s3");
  const key = storageS3ObjectName(config, "_uploads", `.cors-check-${Date.now()}`);
  const client = storageS3Client(config);
  try {
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn: 60 });
    const response = await fetch(uploadUrl, {
      method: "OPTIONS",
      redirect: "manual",
      signal: AbortSignal.timeout(appConfig.s3CheckTimeoutMs),
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type, content-md5"
      }
    });
    const headers = {
      allow_origin: response.headers.get("access-control-allow-origin") ?? "",
      allow_methods: response.headers.get("access-control-allow-methods") ?? "",
      allow_headers: response.headers.get("access-control-allow-headers") ?? "",
      max_age: response.headers.get("access-control-max-age") ?? ""
    };
    const methods = headers.allow_methods.toUpperCase().split(/\s*,\s*/);
    const allowHeaders = headers.allow_headers.toLowerCase().split(/\s*,\s*/);
    const headerAllowed = (name: string) => headers.allow_headers.includes("*") || allowHeaders.includes(name);
    const originAllowed = headers.allow_origin === "*" || headers.allow_origin === origin;
    const putAllowed = methods.includes("PUT");
    // Content-MD5 is signed into S3 presigned PUTs for upload integrity, so the
    // bucket must allow it as a request header (alongside Content-Type).
    const contentMd5Allowed = headerAllowed("content-md5");
    return {
      origin,
      status: response.status,
      ok: response.status >= 200 && response.status < 300 && originAllowed && putAllowed && headerAllowed("content-type") && contentMd5Allowed,
      content_md5_header_allowed: contentMd5Allowed,
      headers,
      hint: "S3/COS must allow this Origin, PUT method, and the Content-Type and Content-MD5 request headers (or a wildcard) for browser direct uploads with integrity verification."
    };
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key })).catch(() => undefined);
  }
}
