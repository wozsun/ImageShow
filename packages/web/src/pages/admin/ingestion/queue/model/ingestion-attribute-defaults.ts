import type { Brightness, Device } from "../../../../../lib/types.js";

export type IngestionAttributeDefaults = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  tags: string[];
};
