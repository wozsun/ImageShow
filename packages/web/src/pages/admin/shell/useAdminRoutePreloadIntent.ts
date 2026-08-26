import { useCallback } from "react";
import {
  usePreloadIntentProps
} from "../../../lib/ui/preload-intent.js";
import {
  adminRoutePreloadPolicies,
  preloadAdminRouteModule,
  type AdminRouteModuleKey
} from "./admin-route-modules.js";

export function useAdminRoutePreloadIntent(
  moduleKey?: AdminRouteModuleKey
) {
  const preload = useCallback(() => {
    if (moduleKey) preloadAdminRouteModule(moduleKey);
  }, [moduleKey]);

  return usePreloadIntentProps(
    moduleKey ? preload : undefined,
    moduleKey ? adminRoutePreloadPolicies[moduleKey] : undefined
  );
}
