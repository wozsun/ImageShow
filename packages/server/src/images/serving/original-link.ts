import { publicImageUrl } from "../../storage/objects/public-urls.ts";
import { imageResourceBaseUrl } from "../../config/site-host.ts";
import type { StorageRegistryAccess } from "../../storage/backends/registry.ts";

type OriginalComparableImage = {
  id: string;
  ext: string;
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
  access: StorageRegistryAccess = {}
) {
  return publicImageUrl(
    image,
    image.storage_slug,
    access
  );
}

export function hasDistinctOriginalUrl(original: string, displayUrl: string) {
  return /^https:\/\//i.test(original.trim()) && !equivalentUrl(original, displayUrl);
}

export function adminOriginalAccessUrl(
  id: string,
  original: string,
  displayUrl: string
) {
  return hasDistinctOriginalUrl(original, displayUrl)
    ? `${imageResourceBaseUrl()}/original/${encodeURIComponent(id)}`
    : null;
}
