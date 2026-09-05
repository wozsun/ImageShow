import {
  publicNavigationHeaderHideThreshold,
  publicNavigationHeaderRevealThreshold,
  publicNavigationTopRevealThreshold
} from "./public-navigation.js";

const publicImageNavigationThresholds = {
  hideHeader: publicNavigationHeaderHideThreshold,
  hideToolbar: 56,
  revealToolbar: 28,
  revealHeader: publicNavigationHeaderRevealThreshold,
  revealAtTop: publicNavigationTopRevealThreshold
} as const;

export type PublicImageNavigationStage = "visible" | "toolbar-only" | "hidden";

type ScrollDirection = "up" | "down" | null;

export type PublicImageNavigationState = {
  stage: PublicImageNavigationStage;
  direction: ScrollDirection;
  distance: number;
};

export type PublicImageNavigationInput = {
  delta: number;
  headerPresent: boolean;
  scrollTop: number;
  toolbarHeight: number;
  lockedOpen: boolean;
  allowReveal?: boolean;
};

export const initialPublicImageNavigationState: PublicImageNavigationState = {
  stage: "visible",
  direction: null,
  distance: 0
};

function settledState(stage: PublicImageNavigationStage): PublicImageNavigationState {
  return { stage, direction: null, distance: 0 };
}

export function advancePublicImageNavigation(
  state: PublicImageNavigationState,
  input: PublicImageNavigationInput
): PublicImageNavigationState {
  if (
    input.lockedOpen
    || (input.allowReveal !== false
      && input.scrollTop <= publicImageNavigationThresholds.revealAtTop)
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
    if (input.allowReveal === false) return settledState(state.stage);
    if (!input.headerPresent) {
      if (state.stage !== "hidden") return settledState("visible");
      const distance = carriedDistance + stepDistance;
      if (distance < publicImageNavigationThresholds.revealToolbar) {
        return { stage: "hidden", direction, distance };
      }
      return settledState("visible");
    }
    if (state.stage === "visible") return settledState("visible");
    let stage: PublicImageNavigationStage = state.stage;
    let distance = carriedDistance + stepDistance;
    while (stage !== "visible") {
      const threshold = stage === "hidden"
        ? publicImageNavigationThresholds.revealToolbar
        : publicImageNavigationThresholds.revealHeader;
      if (distance < threshold) return { stage, direction, distance };
      distance -= threshold;
      stage = stage === "hidden" ? "toolbar-only" : "visible";
      if (distance === 0) return settledState(stage);
    }
    return settledState("visible");
  }

  if (state.stage === "hidden") return settledState("hidden");
  if (state.stage === "visible" || !input.headerPresent) {
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

  if (!input.headerPresent) {
    const distance = carriedDistance + stepDistance;
    if (distance < publicImageNavigationThresholds.hideToolbar) {
      return { stage: "visible", direction, distance };
    }
    return settledState("hidden");
  }

  let stage: PublicImageNavigationStage = state.stage;
  let distance = carriedDistance + stepDistance;
  while (stage !== "hidden") {
    const threshold = stage === "visible"
      ? publicImageNavigationThresholds.hideHeader
      : publicImageNavigationThresholds.hideToolbar;
    if (distance < threshold) return { stage, direction, distance };
    distance -= threshold;
    stage = stage === "visible" ? "toolbar-only" : "hidden";
    if (distance === 0) return settledState(stage);
  }
  return settledState("hidden");
}
