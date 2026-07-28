import { createContext, useContext } from "react";
import {
  ImageLoadScheduler,
  preferredImageLoadConcurrency
} from "./image-load-scheduler.js";

const ImageLoadSchedulerContext = createContext<ImageLoadScheduler | null>(null);

let fallbackScheduler: ImageLoadScheduler | undefined;

function defaultScheduler() {
  if (!fallbackScheduler) {
    const concurrency = typeof window !== "undefined" && window.matchMedia
      ? preferredImageLoadConcurrency(window.matchMedia.bind(window))
      : 6;
    fallbackScheduler = new ImageLoadScheduler(concurrency);
  }
  return fallbackScheduler;
}

export function ImageLoadSchedulerProvider({
  scheduler,
  children
}: {
  scheduler: ImageLoadScheduler;
  children: React.ReactNode;
}) {
  return (
    <ImageLoadSchedulerContext.Provider value={scheduler}>
      {children}
    </ImageLoadSchedulerContext.Provider>
  );
}

export function useImageLoadScheduler() {
  return useContext(ImageLoadSchedulerContext) ?? defaultScheduler();
}
