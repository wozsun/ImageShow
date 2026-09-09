import { publicImageUrls } from "../storage/objects/public-urls.ts";
import { imageResourceBaseUrl } from "../config/site-host.ts";
import type {
  PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";

type OriginalComparableImage = {
  object_key: string;
  storage_slug: string;
};

function equivalentUrl(left: string, right: string) {
  try {
    const normalize = (value: string) => {
      const url = new URL(value.trim());
      url.hash = "";
      return url.toString();
    };
    return normalize(left) === normalize(right);
  } catch {
    return left.trim() === right.trim();
  }
}

export async function displayUrlForOriginalComparison(
  image: OriginalComparableImage,
  database: PublicDatabaseReadAccess = {}
) {
  const urls = await publicImageUrls(
    image.object_key,
    image.storage_slug,
    database
  );
  return urls.object_url;
}

export function hasDistinctOriginalUrl(original: string, displayUrl: string) {
  return /^https:\/\//i.test(original.trim()) && !equivalentUrl(original, displayUrl);
}

export function publicOriginalAccessUrl(
  id: string,
  original: string,
  displayUrl: string
) {
  return hasDistinctOriginalUrl(original, displayUrl)
    ? `${imageResourceBaseUrl()}/original/${encodeURIComponent(id)}`
    : null;
}
