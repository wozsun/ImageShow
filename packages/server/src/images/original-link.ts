import { publicImageUrls } from "../storage/storage.ts";

type OriginalComparableImage = {
  object_key: string;
  storage_slug: string;
  is_link: boolean;
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

export async function displayUrlForOriginalComparison(image: OriginalComparableImage) {
  if (image.is_link) return image.object_key;
  const urls = await publicImageUrls(image.object_key, image.storage_slug, false);
  return urls.object_url;
}

export function hasDistinctOriginalUrl(original: string, displayUrl: string) {
  return /^https:\/\//i.test(original.trim()) && !equivalentUrl(original, displayUrl);
}
