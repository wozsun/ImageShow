import type { PublicSiteSettings } from "@imageshow/shared/browser";
import { Fragment, useMemo, type ReactNode } from "react";

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
    return href
      ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <Fragment key={key}>{children}</Fragment>;
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

export function HomeFooter({
  site: { icp, mps, footer },
  embedded = false
}: {
  site: Pick<PublicSiteSettings, "icp" | "mps" | "footer">;
  embedded?: boolean;
}) {
  const footerContent = useMemo(() => parseFooter(footer), [footer]);
  const showRegistrations = !embedded && Boolean(icp || mps);
  if (!showRegistrations && !footer) return null;

  return (
    <footer className="home-footer" aria-label="站点信息">
      {showRegistrations && (
        <div className="home-footer-registrations">
          {icp && (
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
              {icp}
            </a>
          )}
          {icp && mps && <span aria-hidden="true">|</span>}
          {mps && (
            <a
              href={`https://beian.mps.gov.cn/#/query/webSearch?code=${mps.replace(/\D/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
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
