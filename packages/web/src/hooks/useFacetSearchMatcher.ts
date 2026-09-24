import { useEffect, useState } from "react";
import { createPageLifetimeModuleLoader } from "../lib/page-lifetime-module-loader.js";
import { matchFacetText } from "../lib/ui/facet-input.js";

const loadPinyinSearch = createPageLifetimeModuleLoader(
  () => import("../lib/ui/pinyin-facet-input.js")
);

/** Load the shared phonetic search capability only while a search surface is open. */
export function useFacetSearchMatcher(enabled: boolean, query: string) {
  const [matchName, setMatchName] = useState(() => matchFacetText);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadPinyinSearch().then(
      (module) => {
        if (!active) return;
        setMatchName(() => module.matchPinyinFacetText);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      }
    );
    return () => {
      active = false;
    };
  }, [enabled]);
  const pending = /[a-zü]/i.test(query) && status === "loading";
  const statusMessage = pending
    ? "正在加载拼音搜索…"
    : status === "error"
      ? "拼音搜索加载失败，仍可按名称或 slug 搜索。"
      : undefined;
  return { matchName, status, pending, statusMessage };
}
