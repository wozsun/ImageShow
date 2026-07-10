declare namespace Temporal {
  interface Instant {
    readonly epochMilliseconds: number;
  }

  interface ZonedDateTime {
    toInstant(): Instant;
  }

  interface PlainDateTime {
    toZonedDateTime(
      timeZone: string,
      options?: { disambiguation?: "compatible" | "earlier" | "later" | "reject" }
    ): ZonedDateTime;
  }
}

declare const Temporal: {
  Instant: {
    from(value: string): Temporal.Instant;
    fromEpochMilliseconds(value: number): Temporal.Instant;
  };
  PlainDateTime: {
    from(value: string): Temporal.PlainDateTime;
  };
  Now: {
    zonedDateTimeISO(timeZone?: string): Temporal.ZonedDateTime;
  };
};
