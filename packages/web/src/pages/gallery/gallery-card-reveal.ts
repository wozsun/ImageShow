export type GalleryCardReveal = {
  variant: "initial" | "subsequent" | "settled";
  delayMs: number;
};

type GalleryCardRevealRegistryOptions = {
  enteredAt?: number;
  routeEntrance: boolean;
};

type GalleryCardRevealOptions = {
  initialViewport: boolean;
  now?: number;
  order: number;
  reduceMotion: boolean;
};

export class GalleryCardRevealRegistry {
  readonly #enteredAt: number;
  readonly #routeEntrance: boolean;
  #revealedThroughIndex = -1;

  constructor(options: GalleryCardRevealRegistryOptions) {
    this.#enteredAt = options.enteredAt
      ?? (globalThis.performance?.now() ?? Date.now());
    this.#routeEntrance = options.routeEntrance;
  }

  prepare(
    imageIndex: number,
    options: GalleryCardRevealOptions
  ): GalleryCardReveal {
    if (
      options.reduceMotion
      || imageIndex <= this.#revealedThroughIndex
    ) {
      return { variant: "settled", delayMs: 0 };
    }

    if (this.#routeEntrance && options.initialViewport) {
      const now = options.now
        ?? (globalThis.performance?.now() ?? Date.now());
      const remainingRouteDelay = Math.max(0, 220 - (now - this.#enteredAt));
      return {
        variant: "initial",
        delayMs: Math.round(
          remainingRouteDelay + Math.min(Math.max(0, options.order) * 32, 300)
        )
      };
    }

    return {
      variant: "subsequent",
      delayMs: Math.min(Math.max(0, options.order) * 18, 120)
    };
  }

  markRevealed(imageIndex: number) {
    this.#revealedThroughIndex = Math.max(
      this.#revealedThroughIndex,
      Math.floor(imageIndex)
    );
  }

  get revealedThroughIndex() {
    return this.#revealedThroughIndex;
  }
}
