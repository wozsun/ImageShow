const homeEntranceTiming = {
  backgroundDeadlineMs: 600,
  globalDeadlineMs: 1_000,
  navigationDelayAfterBackgroundMs: 100,
  heroDelayAfterBackgroundMs: 250,
  catalogDelayAfterBackgroundMs: 800,
  heroDelayAfterDeadlineMs: 80,
  catalogDelayAfterDeadlineMs: 360
} as const;

export type HomeEntranceSnapshot = {
  navigationRevealed: boolean;
  heroRevealed: boolean;
  catalogArmed: boolean;
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
  navigationInitiallyRevealed?: boolean;
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
  #catalogTimer: unknown;
  #navigationRevealAt: number | undefined;
  #heroRevealAt: number | undefined;
  #catalogRevealAt: number | undefined;
  #foregroundSequenceStarted: boolean;
  #deadlineReleased = false;
  #backgroundFailed = false;
  #disposed = false;

  constructor(options: HomeEntranceControllerOptions) {
    this.#onChange = options.onChange;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    const initiallyRevealed = options.initiallyRevealed ?? false;
    this.#snapshot = {
      navigationRevealed:
        initiallyRevealed
        || (options.navigationInitiallyRevealed ?? false),
      heroRevealed: initiallyRevealed,
      catalogArmed: initiallyRevealed,
      backgroundReady: false,
      backgroundReadyAfterForeground: false
    };
    this.#foregroundSequenceStarted = initiallyRevealed;
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
    const now = this.#scheduler.now();
    const deadlineAnchor = this.#deadlineAnchor(now);
    const navigationWasRevealed = this.#snapshot.navigationRevealed;
    this.#clearForegroundTimers();
    this.#revealNavigation();
    const heroRevealAt = navigationWasRevealed
      ? deadlineAnchor
      : deadlineAnchor + homeEntranceTiming.heroDelayAfterDeadlineMs;
    if (now >= heroRevealAt) {
      this.#revealHero();
    } else {
      this.#heroRevealAt = heroRevealAt;
      this.#heroTimer = this.#scheduler.setTimer(() => {
        this.#heroTimer = undefined;
        this.#revealHero();
      }, heroRevealAt - now);
    }
    this.#catalogRevealAt = deadlineAnchor
      + homeEntranceTiming.catalogDelayAfterDeadlineMs;
    if (now >= this.#catalogRevealAt) {
      this.#revealCatalog();
    } else {
      const catalogDelay = this.#catalogRevealAt - now;
      this.#catalogTimer = this.#scheduler.setTimer(() => {
        this.#catalogTimer = undefined;
        this.#revealCatalog();
      }, catalogDelay);
    }
  }

  checkDeadlines() {
    if (this.#disposed || this.#snapshot.catalogArmed) return;
    const now = this.#scheduler.now();
    if (
      !this.#snapshot.heroRevealed
      && !this.#deadlineReleased
      && (
        (
          this.#enteredAt !== undefined
          && now - this.#enteredAt >= homeEntranceTiming.globalDeadlineMs
        )
        || (
          this.#backgroundStartedAt !== undefined
          && now - this.#backgroundStartedAt
            >= homeEntranceTiming.backgroundDeadlineMs
        )
      )
    ) {
      this.reveal();
      return;
    }
    if (
      this.#navigationRevealAt !== undefined
      && now >= this.#navigationRevealAt
    ) {
      this.#revealNavigation();
    }
    if (
      this.#heroRevealAt !== undefined
      && now >= this.#heroRevealAt
    ) {
      this.#revealHero();
    }
    if (
      this.#catalogRevealAt !== undefined
      && now >= this.#catalogRevealAt
    ) {
      this.#revealCatalog();
      return;
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearAllTimers();
  }

  #deadlineAnchor(now: number) {
    const enteredDeadline = this.#enteredAt === undefined
      ? Number.POSITIVE_INFINITY
      : this.#enteredAt + homeEntranceTiming.globalDeadlineMs;
    const backgroundDeadline = this.#backgroundStartedAt === undefined
      ? Number.POSITIVE_INFINITY
      : this.#backgroundStartedAt + homeEntranceTiming.backgroundDeadlineMs;
    return Math.min(now, enteredDeadline, backgroundDeadline);
  }

  #startForegroundSequence() {
    this.#foregroundSequenceStarted = true;
    const now = this.#scheduler.now();
    this.#heroRevealAt = now
      + homeEntranceTiming.heroDelayAfterBackgroundMs;
    this.#catalogRevealAt = now
      + homeEntranceTiming.catalogDelayAfterBackgroundMs;
    if (!this.#snapshot.navigationRevealed) {
      this.#navigationRevealAt = now
        + homeEntranceTiming.navigationDelayAfterBackgroundMs;
      this.#navigationTimer = this.#scheduler.setTimer(() => {
        this.#navigationTimer = undefined;
        this.#revealNavigation();
      }, homeEntranceTiming.navigationDelayAfterBackgroundMs);
    }
    this.#heroTimer = this.#scheduler.setTimer(() => {
      this.#heroTimer = undefined;
      this.#revealHero();
    }, homeEntranceTiming.heroDelayAfterBackgroundMs);
    this.#catalogTimer = this.#scheduler.setTimer(() => {
      this.#catalogTimer = undefined;
      this.#revealCatalog();
    }, homeEntranceTiming.catalogDelayAfterBackgroundMs);
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
    this.#clearDeadlineTimers();
    this.#clearNavigationAndHeroTimers();
    this.#publish();
  }

  #revealCatalog() {
    if (this.#disposed || this.#snapshot.catalogArmed) return;
    this.#snapshot = {
      ...this.#snapshot,
      navigationRevealed: true,
      heroRevealed: true,
      catalogArmed: true
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
        && this.#snapshot.catalogArmed
      )
    ) return;
    this.#foregroundSequenceStarted = true;
    this.#deadlineReleased = true;
    this.#snapshot = {
      ...this.#snapshot,
      navigationRevealed: true,
      heroRevealed: true,
      catalogArmed: true
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

  #clearNavigationAndHeroTimers() {
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

  #clearForegroundTimers() {
    this.#clearNavigationAndHeroTimers();
    this.#catalogRevealAt = undefined;
    if (this.#catalogTimer !== undefined) {
      this.#scheduler.clearTimer(this.#catalogTimer);
      this.#catalogTimer = undefined;
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
