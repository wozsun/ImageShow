import { createContext, type RefObject } from "react";

export const DialogPortalTargetContext = createContext<
  RefObject<HTMLElement | null> | null
>(null);
