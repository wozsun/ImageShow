import { createContext, type RefObject } from "react";

// Portals keep the identity of the disclosure that owns their interaction.
export const InteractionSurfaceContext = createContext<{
  id: string;
  returnFocusRef: RefObject<HTMLElement | null>;
} | null>(null);
