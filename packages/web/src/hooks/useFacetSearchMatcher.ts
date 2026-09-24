import { useEffect, useState } from "react";
import { createPageLifetimeModuleLoader } from "../lib/page-lifetime-module-loader.js";
import { matchFacetText } from "../lib/ui/facet-input.js";

const loadPinyinSearch = createPageLifetimeModuleLoader(
  () => import("../lib/ui/pinyin-facet-input.js")
);

/** Load the shared phonetic search capability only while a search surface is open. */
export function useFacetSearchMatcher(enabled: boolean) {
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
  return { matchName, status };
}
