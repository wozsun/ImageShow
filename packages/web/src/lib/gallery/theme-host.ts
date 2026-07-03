export function themeFromHostname(hostname: string, rootDomain: string) {
  const host = hostname.toLowerCase();
  const root = rootDomain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "");
  if (!host.endsWith(`.${root}`)) return "";
  const prefix = host.slice(0, -root.length - 1);
  if (!prefix || prefix.includes(".")) return "";
  return prefix;
}

export function rootSiteOrigin(rootDomain: string) {
  const configured = rootDomain.replace(/^https?:\/\//, "").split("/")[0];
  const hasPort = /:\d+$/.test(configured);
  const currentPort = window.location.port;
  const host = hasPort || !currentPort ? configured : `${configured}:${currentPort}`;
  return `${window.location.protocol}//${host}/`;
}
