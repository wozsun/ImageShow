import {
  createElement,
  lazy,
  type ComponentProps,
  type LazyExoticComponent
} from "react";
import {
  createPageLifetimeModuleLoader
} from "../../lib/page-lifetime-module-loader.js";

type ImageAdminDetailsModule =
  typeof import("./ImageAdminDetails.js");
type ImageAdminDetailsComponent =
  ImageAdminDetailsModule["ImageAdminDetails"];
type ImageAdminDetailsProps =
  ComponentProps<ImageAdminDetailsComponent>;

export const loadImageAdminDetailsModule =
  createPageLifetimeModuleLoader<ImageAdminDetailsModule>(
    () => import("./ImageAdminDetails.js")
  );

const LazyImageAdminDetailsComponent: LazyExoticComponent<
  ImageAdminDetailsComponent
> = lazy(() => loadImageAdminDetailsModule()
  .then((module) => ({ default: module.ImageAdminDetails })));

export function LazyImageAdminDetails(props: ImageAdminDetailsProps) {
  return createElement(LazyImageAdminDetailsComponent, props);
}
