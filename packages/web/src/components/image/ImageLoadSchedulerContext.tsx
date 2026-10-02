import { createContext, useContext } from "react";
import {
  ImageLoadScheduler,
  preferredImageLoadConcurrency
} from "./image-load-scheduler.js";

const ImageLoadSchedulerContext = createContext<ImageLoadScheduler | null>(null);

let fallbackScheduler: ImageLoadScheduler | undefined;

function defaultScheduler() {
  if (!fallbackScheduler) {
    const concurrency = preferredImageLoadConcurrency(window.matchMedia.bind(window));
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
