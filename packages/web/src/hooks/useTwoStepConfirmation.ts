import { useCallback, useEffect, useRef, useState } from "react";

export function useTwoStepConfirmation<T extends HTMLElement = HTMLElement>(input: Readonly<{
  disabled?: boolean;
  busy?: boolean;
  invalidationKey?: string;
  onDisarm?: () => void;
}>) {
  const targetRef = useRef<T | null>(null);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const onDisarmRef = useRef(input.onDisarm);
  onDisarmRef.current = input.onDisarm;
  const disabled = input.disabled === true;
  const busy = input.busy === true;

  const updateArmed = useCallback((next: boolean) => {
    armedRef.current = next;
    setArmed(next);
  }, []);
  const disarm = useCallback(() => {
    if (!armedRef.current) return;
    updateArmed(false);
    onDisarmRef.current?.();
  }, [updateArmed]);

  useEffect(() => {
    if (!armed) return;
    const disarmOutsideTarget = (event: PointerEvent) => {
      if (!targetRef.current?.contains(event.target as Node)) disarm();
    };
    document.addEventListener("pointerdown", disarmOutsideTarget, true);
    return () => {
      document.removeEventListener("pointerdown", disarmOutsideTarget, true);
    };
  }, [armed, disarm]);

  useEffect(() => {
    disarm();
  }, [busy, disabled, disarm, input.invalidationKey]);

  return {
    targetRef,
    armed: armed && !disabled && !busy,
    disarm,
    onBlur: disarm,
    activate(onArm: () => boolean | void, onConfirm: () => void) {
      if (disabled || busy) return;
      if (!armed) {
        if (onArm() === false) return;
        updateArmed(true);
        return;
      }
      // A confirmed action owns its frozen intent until it reaches a known
      // result. This transition is not an abandoned confirmation.
      updateArmed(false);
      onConfirm();
    }
  };
}
