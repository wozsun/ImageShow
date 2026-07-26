import { useLayoutEffect, useRef } from "react";

type InputElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Owns one focused IME editing session for a controlled input.
 *
 * WebKit may deliver the final composition/input pair after blur. Once a
 * session is settled, those late events must restore the rendered value rather
 * than publish stale composition text into the next controlled render.
 */
export function useImeInputSession(settledValue: string) {
  const stateRef = useRef({
    active: false,
    composing: false,
    settledValue
  });

  useLayoutEffect(() => {
    if (!stateRef.current.active) {
      stateRef.current.settledValue = settledValue;
    }
  }, [settledValue]);

  const restoreSettledValue = (input: InputElement) => {
    input.value = stateRef.current.settledValue;
  };

  return {
    beginEditing() {
      stateRef.current.active = true;
      stateRef.current.composing = false;
    },
    beginComposition() {
      stateRef.current.active = true;
      stateRef.current.composing = true;
    },
    isComposing(nativeIsComposing = false) {
      return stateRef.current.composing || nativeIsComposing;
    },
    acceptInput(input: InputElement) {
      if (stateRef.current.active) return true;
      restoreSettledValue(input);
      return false;
    },
    endComposition(input: InputElement) {
      const belongsToCurrentSession =
        stateRef.current.active && stateRef.current.composing;
      stateRef.current.composing = false;
      if (belongsToCurrentSession) return true;
      restoreSettledValue(input);
      return false;
    },
    settleEditing(value: string) {
      stateRef.current.active = false;
      stateRef.current.composing = false;
      stateRef.current.settledValue = value;
    }
  };
}
