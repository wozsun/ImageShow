export function hasDistinctOriginalUrl(
  original: string,
  displayUrl: string
) {
  if (!/^https:\/\//i.test(original.trim())) return false;
  try {
    const normalize = (value: string) => {
      const url = new URL(value.trim());
      url.hash = "";
      return url.toString();
    };
    return normalize(original) !== normalize(displayUrl);
  } catch {
    return original.trim() !== displayUrl.trim();
  }
}
