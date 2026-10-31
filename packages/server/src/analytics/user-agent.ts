import { detectDeviceFromUserAgent } from "@imageshow/shared/browser";

export type VisitorAgent = {
  device: "mobile" | "desktop";
  browser: string;
  browserMajor: number | null;
  os: string;
};

// Browsers always send a user agent; automation, crawlers and HTTP libraries
// either omit it or name themselves. Crawlers write "…bot" followed by a
// version, hyphen or bracket; a bare "bot" ending a word would also match
// phone models such as CUBOT.
const automatedAgentPattern =
  /\bbot\b|bot[-/;)]|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|headless|lighthouse|pagespeed|phantomjs|puppeteer|playwright|selenium|python|curl\/|wget\/|httpclient|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|monitor|uptime|preview/iu;

// Order matters: Chromium-based browsers also carry "Chrome/" and "Safari/".
const browserPatterns: readonly [string, RegExp][] = [
  ["WeChat", /MicroMessenger\/(\d+)/u],
  ["Weibo", /Weibo \(|__weibo__(\d+)?/u],
  ["QQ", /M?QQBrowser\/(\d+)/u],
  ["UC", /UCBrowser\/(\d+)/u],
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/u],
  ["Opera", /(?:OPR|OPT)\/(\d+)/u],
  ["Samsung", /SamsungBrowser\/(\d+)/u],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/u],
  ["Chrome", /(?:Chrome|CriOS)\/(\d+)/u],
  ["Safari", /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//u]
];

const systemPatterns: readonly [string, RegExp][] = [
  ["HarmonyOS", /HarmonyOS|OpenHarmony/u],
  ["Windows", /Windows NT/u],
  ["Android", /Android/u],
  ["iOS", /iPhone|iPad|iPod/u],
  ["macOS", /Macintosh|Mac OS X/u],
  ["ChromeOS", /CrOS/u],
  ["Linux", /Linux|X11/u]
];

/** Coarse browser, system and device for statistics; the full string is never stored. */
export function visitorAgent(userAgent: string): VisitorAgent | null {
  if (!userAgent.trim() || automatedAgentPattern.test(userAgent)) return null;
  let browser = "Other";
  let browserMajor: number | null = null;
  for (const [name, pattern] of browserPatterns) {
    const match = pattern.exec(userAgent);
    if (!match) continue;
    browser = name;
    const major = match[1] ? Number(match[1]) : Number.NaN;
    browserMajor = Number.isSafeInteger(major) && major < 10_000 ? major : null;
    break;
  }
  const os = systemPatterns.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "Other";
  return {
    device: detectDeviceFromUserAgent(userAgent) === "mb" ? "mobile" : "desktop",
    browser,
    browserMajor,
    os
  };
}
