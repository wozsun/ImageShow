import type { AuthorDerivedIdentityDto } from "@imageshow/shared/browser";
import { appConfig } from "@imageshow/shared";

const supportedAuthorIdentityProviders = appConfig.authorIdentity.providers;
type AuthorIdentityProvider =
  (typeof supportedAuthorIdentityProviders)[number];

export type AuthorIdentity = {
  provider: AuthorIdentityProvider;
  id: string;
};

export type AuthorIdentityColumns = {
  identity_provider: string | null;
  identity_id: string | null;
};

const weiboUserIdPattern = /^[1-9]\d{0,19}$/u;

export function isWeiboUserId(value: string) {
  return weiboUserIdPattern.test(value);
}

/**
 * Derive a stable import identity from the public author homepage.
 * Unrecognized HTTPS links remain valid public links and deliberately have no
 * internal identity.
 */
export function deriveAuthorIdentityFromLink(link: string): AuthorIdentity | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "weibo.com"
    || url.username
    || url.password
    || url.port
  ) {
    return null;
  }
  const match = /^\/u\/([1-9]\d{0,19})\/?$/u.exec(url.pathname);
  return match ? { provider: "weibo", id: match[1]! } : null;
}

export function canonicalWeiboAuthorHomepage(userId: string) {
  if (!isWeiboUserId(userId)) {
    throw new Error("Cannot build a Weibo author homepage for an invalid user ID");
  }
  return `https://weibo.com/u/${userId}`;
}

export function projectAuthorDerivedIdentity(
  columns: AuthorIdentityColumns
): AuthorDerivedIdentityDto | null {
  if (
    columns.identity_provider === "weibo"
    && columns.identity_id !== null
  ) {
    return { provider: "weibo", id: columns.identity_id };
  }
  return null;
}
