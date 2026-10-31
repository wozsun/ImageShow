import {
  analyticsTodayVisitorsPath,
  type AnalyticsTodayVisitorsDto,
  type PublicSiteSettings
} from "@imageshow/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, type ReactNode } from "react";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";

function footerLink(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function footerNodes(nodes: NodeListOf<ChildNode>, prefix = ""): ReactNode[] {
  return Array.from(nodes, (node, index) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
    const key = `${prefix}${index}`;
    if (element.localName === "br") return <br key={key} />;
    if (element.localName !== "a") return null;
    const children = footerNodes(element.childNodes, `${key}-`);
    const href = footerLink(element.getAttribute("href"));
    return href ? (
      <a key={key} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <Fragment key={key}>{children}</Fragment>
    );
  });
}

function parseFooter(source: string) {
  if (!source) return null;
  // Template contents remain detached and inert. Only newly created React
  // text, anchor and line-break nodes are rendered; input nodes and attributes
  // are never attached to the live document.
  const template = document.createElement("template");
  template.innerHTML = source;
  return footerNodes(template.content.childNodes);
}

/** Today's distinct visitors of the whole site; undefined until the count arrives. */
function useTodayVisitors(enabled: boolean) {
  const visitors = useQuery({
    queryKey: queryKeys.todayVisitors,
    queryFn: ({ signal }) => api<AnalyticsTodayVisitorsDto>(analyticsTodayVisitorsPath, { signal }),
    enabled,
    staleTime: 60_000,
    retry: false
  }).data?.visitors;
  return enabled ? visitors : undefined;
}

export function HomeFooter({
  site: { icp, mps, footer },
  embedded = false,
  todayVisitors = false
}: {
  site: Pick<PublicSiteSettings, "icp" | "mps" | "footer">;
  embedded?: boolean;
  todayVisitors?: boolean;
}) {
  const footerContent = useMemo(() => parseFooter(footer), [footer]);
  // An empty footer would leave a bare landmark and shift once the count arrives.
  const visitors = useTodayVisitors(todayVisitors && !embedded);
  const showRegistrations = !embedded && Boolean(icp || mps);
  if (!showRegistrations && !footer && visitors === undefined) return null;

  return (
    <footer className="home-footer" aria-label="站点信息">
      {visitors !== undefined && (
        <p className="home-footer-text">今日访客 {visitors.toLocaleString("zh-CN")}</p>
      )}
      {showRegistrations && (
        <div className="home-footer-registrations">
          {icp && (
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
              {icp}
            </a>
          )}
          {icp && mps && <span aria-hidden="true">|</span>}
          {mps && (
            <a
              href={`https://beian.mps.gov.cn/#/query/webSearch?code=${mps.replace(/\D/g, "")}`}
              target="_blank"
              rel="noreferrer"
            >
              {mps}
            </a>
          )}
        </div>
      )}
      {footer && <p className="home-footer-text">{footerContent}</p>}
    </footer>
  );
}
