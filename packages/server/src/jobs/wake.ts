type WakeListener = () => void;

let listener: WakeListener | undefined;

/** The running worker subscribes; producers stay free of a worker import. */
export function subscribeBackgroundJobWake(next: WakeListener) {
  listener = next;
  return () => {
    if (listener === next) listener = undefined;
  };
}

/**
 * Call only after the transaction that made jobs runnable has committed. The
 * periodic scan remains the durable fallback for a missed or early signal.
 */
export function wakeBackgroundJobs() {
  listener?.();
}
