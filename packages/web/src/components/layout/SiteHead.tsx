import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { ensureMeta } from "../../lib/ui/document-meta.js";
import { adminBasePath } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-queries.js";
import { applyUiColorContext } from "../../lib/ui/apply-ui-color-context.js";

function isAdminRoute(pathname: string) {
  return pathname === adminBasePath
    || pathname.startsWith(`${adminBasePath}/`);
}

// maximum-scale=1 阻止 iOS Safari 在输入框字号小于 16px 时聚焦自动放大整页；iOS 仍允许用户双指缩放。
// 与 index.html 的初始值保持一致。
const baseViewportContent = "width=device-width, initial-scale=1.0, maximum-scale=1";

export function SiteHead() {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const site = data?.site;

  useLayoutEffect(() => {
    const immersive = /^\/(?:home|gallery|show|embed\/(?:home|gallery|show))?\/?$/i.test(pathname);
    const viewport = ensureMeta("viewport");
    viewport.content = baseViewportContent + (immersive ? ", viewport-fit=cover" : "");
    document.documentElement.toggleAttribute("data-public-viewport", immersive);
    return () => {
      viewport.content = baseViewportContent;
      document.documentElement.removeAttribute("data-public-viewport");
    };
  }, [pathname]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (isAdminRoute(pathname)) {
      if (root.dataset.uiContext !== "admin") {
        applyUiColorContext("bootstrap");
      }
      return;
    }
    // 公开域只有在站点配置真实可用后才接管颜色。初始读取失败时继续保留
    // index.html 的 bootstrap 画布，避免错误文字落入尚未就绪的公开颜色域。
    if (site) applyUiColorContext("public");
    else applyUiColorContext("bootstrap");
  }, [pathname, site]);

  useEffect(() => {
    if (!site) return;
    document.title = site.title;
    const description = ensureMeta("description");
    description.content = site.description;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = site.icon.endsWith(".svg") ? "image/svg+xml" : "";
    link.href = site.icon;
  }, [site?.title, site?.description, site?.icon]);
  return null;
}
