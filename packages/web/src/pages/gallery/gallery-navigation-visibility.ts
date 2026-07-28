const galleryNavigationThresholds = {
  hideToolbar: 18,
  hideHeader: 48,
  revealHeader: 16,
  revealToolbar: 18,
  revealAtTop: 18
} as const;

export type GalleryNavigationStage = "visible" | "header-only" | "hidden";

type ScrollDirection = "up" | "down" | null;

export type GalleryNavigationState = {
  stage: GalleryNavigationStage;
  direction: ScrollDirection;
  distance: number;
};

export type GalleryNavigationInput = {
  delta: number;
  scrollTop: number;
  toolbarHeight: number;
  lockedOpen: boolean;
};

export const initialGalleryNavigationState: GalleryNavigationState = {
  stage: "visible",
  direction: null,
  distance: 0
};

function settledState(stage: GalleryNavigationStage): GalleryNavigationState {
  return { stage, direction: null, distance: 0 };
}

export function advanceGalleryNavigation(
  state: GalleryNavigationState,
  input: GalleryNavigationInput
): GalleryNavigationState {
  if (
    input.lockedOpen
    || input.scrollTop <= galleryNavigationThresholds.revealAtTop
  ) {
    return settledState("visible");
  }
  if (input.delta === 0) return state;

  const direction: Exclude<ScrollDirection, null> =
    input.delta < 0 ? "up" : "down";
  let carriedDistance = (
    state.direction === direction ? state.distance : 0
  );
  let stepDistance = Math.abs(input.delta);

  if (direction === "up") {
    if (state.stage === "visible") return settledState("visible");
    let stage: GalleryNavigationStage = state.stage;
    let distance = carriedDistance + stepDistance;
    while (stage !== "visible") {
      const threshold = stage === "hidden"
        ? galleryNavigationThresholds.revealHeader
        : galleryNavigationThresholds.revealToolbar;
      if (distance < threshold) return { stage, direction, distance };
      distance -= threshold;
      stage = stage === "hidden" ? "header-only" : "visible";
      if (distance === 0) return settledState(stage);
    }
    return settledState("visible");
  }

  if (state.stage === "hidden") return settledState("hidden");
  if (state.stage === "visible") {
    const toolbarBoundary = Math.max(0, input.toolbarHeight);
    const previousScrollTop = input.scrollTop - input.delta;
    if (input.scrollTop <= toolbarBoundary) return settledState("visible");
    if (previousScrollTop < toolbarBoundary) carriedDistance = 0;
    stepDistance = input.scrollTop - Math.max(
      toolbarBoundary,
      previousScrollTop
    );
    if (stepDistance <= 0) return settledState("visible");
  }

  let stage: GalleryNavigationStage = state.stage;
  let distance = carriedDistance + stepDistance;
  while (stage !== "hidden") {
    const threshold = stage === "visible"
      ? galleryNavigationThresholds.hideToolbar
      : galleryNavigationThresholds.hideHeader;
    if (distance < threshold) return { stage, direction, distance };
    distance -= threshold;
    stage = stage === "visible" ? "header-only" : "hidden";
    if (distance === 0) return settledState(stage);
  }
  return settledState("hidden");
}
