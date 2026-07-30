const homeEntranceTiming = {
  backgroundDeadlineMs: 600,
  globalDeadlineMs: 1_000,
  navigationDelayAfterBackgroundMs: 80,
  heroDelayAfterBackgroundMs: 160,
  heroDelayAfterDeadlineMs: 80
} as const;

export type HomeEntranceSnapshot = {
  navigationRevealed: boolean;
  heroRevealed: boolean;
  backgroundReady: boolean;
  backgroundReadyAfterForeground: boolean;
};

type HomeEntranceScheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

type HomeEntranceControllerOptions = {
  initiallyRevealed?: boolean;
  onChange: (snapshot: HomeEntranceSnapshot) => void;
  scheduler?: HomeEntranceScheduler;
};

const defaultScheduler: HomeEntranceScheduler = {
  now: () => globalThis.performance?.now() ?? Date.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (handle) => globalThis.clearTimeout(
    handle as ReturnType<typeof setTimeout>
  )
};

export class HomeEntranceController {
  readonly #onChange: HomeEntranceControllerOptions["onChange"];
  readonly #scheduler: HomeEntranceScheduler;
  #snapshot: HomeEntranceSnapshot;
  #enteredAt: number | undefined;
  #backgroundStartedAt: number | undefined;
  #globalTimer: unknown;
  #backgroundTimer: unknown;
  #navigationTimer: unknown;
  #heroTimer: unknown;
  #navigationRevealAt: number | undefined;
  #heroRevealAt: number | undefined;
  #foregroundSequenceStarted: boolean;
  #deadlineReleased = false;
  #backgroundFailed = false;
  #disposed = false;

  constructor(options: HomeEntranceControllerOptions) {
    this.#onChange = options.onChange;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#snapshot = {
      navigationRevealed: options.initiallyRevealed ?? false,
      heroRevealed: options.initiallyRevealed ?? false,
      backgroundReady: false,
      backgroundReadyAfterForeground: false
    };
    this.#foregroundSequenceStarted = options.initiallyRevealed ?? false;
  }

  get snapshot() {
    return this.#snapshot;
  }

  start() {
    if (this.#disposed || this.#enteredAt !== undefined) return;
    this.#enteredAt = this.#scheduler.now();
    if (!this.#snapshot.heroRevealed) {
      this.#globalTimer = this.#scheduler.setTimer(
        () => this.reveal(),
        homeEntranceTiming.globalDeadlineMs
      );
    }
  }

  backgroundRequestStarted() {
    if (this.#disposed || this.#backgroundStartedAt !== undefined) return;
    this.#backgroundStartedAt = this.#scheduler.now();
    if (!this.#snapshot.heroRevealed) {
      this.#backgroundTimer = this.#scheduler.setTimer(
        () => this.reveal(),
        homeEntranceTiming.backgroundDeadlineMs
      );
    }
  }

  backgroundBecameReady() {
    if (
      this.#disposed
      || this.#backgroundFailed
      || this.#snapshot.backgroundReady
    ) return;
    this.#snapshot = {
      ...this.#snapshot,
      backgroundReady: true,
      backgroundReadyAfterForeground: this.#foregroundSequenceStarted
    };
    this.#publish();
    if (!this.#foregroundSequenceStarted) {
      this.#startForegroundSequence();
    }
  }

  backgroundFailed() {
    if (
      this.#disposed
      || this.#backgroundFailed
      || this.#snapshot.backgroundReady
    ) return;
    this.#backgroundFailed = true;
    this.revealImmediately();
  }

  revealImmediately() {
    this.#revealForegroundImmediately();
  }

  reveal() {
    if (
      this.#disposed
      || this.#snapshot.heroRevealed
      || this.#deadlineReleased
    ) return;
    this.#deadlineReleased = true;
    this.#foregroundSequenceStarted = true;
    const navigationWasRevealed = this.#snapshot.navigationRevealed;
    this.#clearForegroundTimers();
    this.#revealNavigation();
    if (navigationWasRevealed) {
      this.#revealHero();
      return;
    }
    this.#heroRevealAt = this.#scheduler.now()
      + homeEntranceTiming.heroDelayAfterDeadlineMs;
    this.#heroTimer = this.#scheduler.setTimer(() => {
      this.#heroTimer = undefined;
      this.#revealHero();
    }, homeEntranceTiming.heroDelayAfterDeadlineMs);
  }

  checkDeadlines() {
    if (this.#disposed || this.#snapshot.heroRevealed) return;
    const now = this.#scheduler.now();
    if (
      this.#heroRevealAt !== undefined
      && now >= this.#heroRevealAt
    ) {
      this.#revealHero();
      return;
    }
    if (
      this.#navigationRevealAt !== undefined
      && now >= this.#navigationRevealAt
    ) {
      this.#revealNavigation();
    }
    if (
      this.#enteredAt !== undefined
      && now - this.#enteredAt >= homeEntranceTiming.globalDeadlineMs
    ) {
      this.reveal();
      return;
    }
    if (
      this.#backgroundStartedAt !== undefined
      && now - this.#backgroundStartedAt
        >= homeEntranceTiming.backgroundDeadlineMs
    ) {
      this.reveal();
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearAllTimers();
  }

  #startForegroundSequence() {
    this.#foregroundSequenceStarted = true;
    const now = this.#scheduler.now();
    this.#navigationRevealAt = now
      + homeEntranceTiming.navigationDelayAfterBackgroundMs;
    this.#heroRevealAt = now
      + homeEntranceTiming.heroDelayAfterBackgroundMs;
    this.#navigationTimer = this.#scheduler.setTimer(() => {
      this.#navigationTimer = undefined;
      this.#revealNavigation();
    }, homeEntranceTiming.navigationDelayAfterBackgroundMs);
    this.#heroTimer = this.#scheduler.setTimer(() => {
      this.#heroTimer = undefined;
      this.#revealHero();
    }, homeEntranceTiming.heroDelayAfterBackgroundMs);
  }

  #revealNavigation() {
    if (this.#disposed || this.#snapshot.navigationRevealed) return;
    this.#navigationRevealAt = undefined;
    this.#snapshot = {
      ...this.#snapshot,
      navigationRevealed: true
    };
    this.#publish();
  }

  #revealHero() {
    if (this.#disposed || this.#snapshot.heroRevealed) return;
    this.#navigationRevealAt = undefined;
    this.#heroRevealAt = undefined;
    this.#snapshot = {
      ...this.#snapshot,
      navigationRevealed: true,
      heroRevealed: true
    };
    this.#clearAllTimers();
    this.#publish();
  }

  #revealForegroundImmediately() {
    if (
      this.#disposed
      || (
        this.#snapshot.navigationRevealed
        && this.#snapshot.heroRevealed
      )
    ) return;
    this.#foregroundSequenceStarted = true;
    this.#deadlineReleased = true;
    this.#snapshot = {
      ...this.#snapshot,
      navigationRevealed: true,
      heroRevealed: true
    };
    this.#clearAllTimers();
    this.#publish();
  }

  #clearDeadlineTimers() {
    if (this.#globalTimer !== undefined) {
      this.#scheduler.clearTimer(this.#globalTimer);
      this.#globalTimer = undefined;
    }
    if (this.#backgroundTimer !== undefined) {
      this.#scheduler.clearTimer(this.#backgroundTimer);
      this.#backgroundTimer = undefined;
    }
  }

  #clearForegroundTimers() {
    this.#navigationRevealAt = undefined;
    this.#heroRevealAt = undefined;
    if (this.#navigationTimer !== undefined) {
      this.#scheduler.clearTimer(this.#navigationTimer);
      this.#navigationTimer = undefined;
    }
    if (this.#heroTimer !== undefined) {
      this.#scheduler.clearTimer(this.#heroTimer);
      this.#heroTimer = undefined;
    }
  }

  #clearAllTimers() {
    this.#clearDeadlineTimers();
    this.#clearForegroundTimers();
  }

  #publish() {
    this.#onChange(this.#snapshot);
  }
}
