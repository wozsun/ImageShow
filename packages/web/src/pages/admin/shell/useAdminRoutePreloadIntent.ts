import { useCallback } from "react";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import {
  preloadAdminRouteModule,
  type AdminRouteModuleKey
} from "./admin-route-modules.js";

export function useAdminRoutePreloadIntent(moduleKey?: AdminRouteModuleKey) {
  const preload = useCallback(() => {
    if (moduleKey) preloadAdminRouteModule(moduleKey);
  }, [moduleKey]);

  return preloadIntentProps(
    moduleKey ? preload : undefined
  );
}
