import type { Container, Renderer } from "pixi.js";
import type { ShowMode, ShowOrder } from "@imageshow/shared/browser";
import type { ShowImage } from "../show-layout.js";

export type ShowPixiSceneKind = ShowMode;

export type ShowPixiVisibleItem = {
  key: string;
  image: ShowImage;
};

export type ShowPixiTextureStats = {
  entries: number;
  ready: number;
  queued: number;
  inFlight: number;
  referenced: number;
  reservedPixels: number;
  mipmapped: number;
  lod128: number;
  lod256: number;
  lod512: number;
  rejected: number;
  failures: number;
  evictions: number;
};

export type ShowPixiSceneStats = {
  activeSprites: number;
  visibleSprites: number;
  retainedDtos: number;
  recycledSprites: number;
  rejectedSprites: number;
  overlapRatio: number;
  coverageRatio: number;
  horizontalConcentration: number;
  layoutRevision: number;
  inputEnabled: boolean;
  inputListenerCount: number;
  activePointers: number;
  waterfallColumns: number | null;
  waterfallCameraX: number | null;
  waterfallCameraY: number | null;
  waterfallScale: number | null;
  floatSizeIndex: number | null;
  floatMeanY: number | null;
};

export type ShowPixiRuntimeSnapshot = ShowPixiSceneStats & {
  renderer: string;
  scene: ShowPixiSceneKind;
  running: boolean;
  motionActive: boolean;
  reducedMotion: boolean;
  hidden: boolean;
  dialogOpen: boolean;
  contextLost: boolean;
  contextLosses: number;
  contextRestores: number;
  frames: number;
  averageFrameMs: number;
  p95FrameMs: number;
  longFrames: number;
  longTasks: number;
  longTaskMs: number;
  tickerListeners: number;
  textures: ShowPixiTextureStats;
};

export type ShowPixiSceneOptions = {
  images: readonly ShowImage[];
  dataKey: string;
  order: ShowOrder;
  width: number;
  height: number;
  renderer: Renderer;
  running: boolean;
  reducedMotion: boolean;
  onNeedImages: () => void;
  onOpen: (image: ShowImage, key: string) => void;
  onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
};

export interface ShowPixiSceneController {
  readonly kind: ShowPixiSceneKind;
  readonly root: Container;
  clearPointerHover(): void;
  destroy(): void;
  focusCard(key: string | null): void;
  resize(width: number, height: number): void;
  setImages(images: readonly ShowImage[], dataKey: string, order: ShowOrder): void;
  setInputEnabled(enabled: boolean): void;
  setMotion(running: boolean, reducedMotion: boolean): void;
  stats(): ShowPixiSceneStats;
  update(elapsedMs: number): void;
}

export const emptyShowPixiSceneStats = (): ShowPixiSceneStats => ({
  activeSprites: 0,
  visibleSprites: 0,
  retainedDtos: 0,
  recycledSprites: 0,
  rejectedSprites: 0,
  overlapRatio: 0,
  coverageRatio: 0,
  horizontalConcentration: 0,
  layoutRevision: 0,
  inputEnabled: false,
  inputListenerCount: 0,
  activePointers: 0,
  waterfallColumns: null,
  waterfallCameraX: null,
  waterfallCameraY: null,
  waterfallScale: null,
  floatSizeIndex: null,
  floatMeanY: null
});
