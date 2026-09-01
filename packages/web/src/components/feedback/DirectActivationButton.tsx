import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent
} from "react";
import {
  classifyMovementIntent,
  type ClientPoint,
  type MovementIntent
} from "../../lib/ui/movement-intent.js";

type CompatibilityActivationGuard = {
  release: () => void;
  renew: () => void;
};

type DirectPointerPress = {
  pointerId: number;
  origin: ClientPoint;
  movementIntent: MovementIntent | null;
};

const pendingActivationSuppressions =
  new WeakMap<Document, CompatibilityActivationGuard>();
const compatibilityMouseEvents = ["mousedown", "mouseup"] as const;

/**
 * A touch can produce a delayed compatibility mouse sequence after pointerup.
 * Consume the complete activation sequence at window capture, so a synchronous
 * removal, disable or repaint cannot expose another control to mousedown focus
 * or a retargeted click. The guard survives that update and is replaced by the
 * next physical pointer gesture.
 */
function suppressCompatibilityActivation(ownerDocument: Document) {
  const pending = pendingActivationSuppressions.get(ownerDocument);
  if (pending) {
    pending.renew();
    return;
  }

  const eventRoot: EventTarget = ownerDocument.defaultView ?? ownerDocument;
  let timeoutId: number | undefined;
  let captureCompatibilityMouse: EventListener;
  let captureClick: EventListener;
  let releaseForNextPointer: EventListener;
  const release = () => {
    for (const eventName of compatibilityMouseEvents) {
      eventRoot.removeEventListener(
        eventName,
        captureCompatibilityMouse,
        true
      );
    }
    eventRoot.removeEventListener("click", captureClick, true);
    eventRoot.removeEventListener("pointerdown", releaseForNextPointer, true);
    if (timeoutId !== undefined) {
      ownerDocument.defaultView?.clearTimeout(timeoutId);
    }
    if (pendingActivationSuppressions.get(ownerDocument) === guard) {
      pendingActivationSuppressions.delete(ownerDocument);
    }
  };
  const renew = () => {
    if (timeoutId !== undefined) {
      ownerDocument.defaultView?.clearTimeout(timeoutId);
    }
    timeoutId = ownerDocument.defaultView?.setTimeout(release, 800);
  };
  const guard = { release, renew };
  captureCompatibilityMouse = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  captureClick = (event) => {
    const click = event as MouseEvent;
    // Keyboard and assistive-technology activation conventionally use
    // detail=0 and must keep the native click path.
    if (click.detail === 0) return;
    click.preventDefault();
    click.stopImmediatePropagation();
    release();
  };
  releaseForNextPointer = (event) => {
    const pointer = event as globalThis.PointerEvent;
    if (pointer.isPrimary === false) return;
    release();
  };

  pendingActivationSuppressions.set(ownerDocument, guard);
  for (const eventName of compatibilityMouseEvents) {
    eventRoot.addEventListener(
      eventName,
      captureCompatibilityMouse,
      true
    );
  }
  eventRoot.addEventListener("click", captureClick, true);
  // A new physical press belongs to a new gesture. It releases a stale guard
  // before that pointer reaches its target, where another direct control can
  // arm the next transaction if necessary.
  eventRoot.addEventListener("pointerdown", releaseForNextPointer, true);
  renew();
}

export type DirectActivationButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onClick"
  | "onPointerCancel"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onLostPointerCapture"
> & {
  onActivate: () => void;
  pointerFocus?: "preserve" | "release-after-activation" | "target";
};

function useDirectActivation(
  onActivate: () => void,
  pointerFocus: NonNullable<DirectActivationButtonProps["pointerFocus"]>
) {
  const pointerPressRef = useRef<DirectPointerPress | null>(null);

  const clearPointerPress = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerPressRef.current?.pointerId === event.pointerId) {
      pointerPressRef.current = null;
    }
  };
  const cancelPointerPress = (event: PointerEvent<HTMLButtonElement>) => {
    if (
      pointerPressRef.current?.pointerId === event.pointerId
      && event.pointerType !== "mouse"
    ) {
      // Refresh the post-gesture window from cancellation rather than from
      // pointerdown, so a long press cannot outlive its suppression.
      suppressCompatibilityActivation(event.currentTarget.ownerDocument);
    }
    clearPointerPress(event);
  };

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      const directPrimaryPress = (
        !event.currentTarget.disabled
        && event.pointerType !== "mouse"
        && event.isPrimary !== false
        && event.button === 0
      );
      if (pointerFocus === "preserve" || directPrimaryPress) {
        // Cancelling pointerdown asks conforming browsers not to emit
        // compatibility mouse events. The capture guard still handles click,
        // which Pointer Events defines independently, plus WebKit sequences
        // already queued around synchronous UI teardown.
        event.preventDefault();
      }
      if (directPrimaryPress && pointerFocus !== "preserve") {
        // Preventing the compatibility mouse sequence also prevents the
        // browser's normal focus transfer. Recreate that transfer during the
        // press so focused editors settle before pointerup activates the
        // button, matching the mouse mousedown -> click order.
        event.currentTarget.focus({ preventScroll: true });
      }
      if (!directPrimaryPress) {
        pointerPressRef.current = null;
        return;
      }
      pointerPressRef.current = {
        pointerId: event.pointerId,
        origin: {
          clientX: event.clientX,
          clientY: event.clientY
        },
        movementIntent: null
      };
      suppressCompatibilityActivation(event.currentTarget.ownerDocument);
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const press = pointerPressRef.current;
      if (
        !press
        || press.pointerId !== event.pointerId
        || press.movementIntent
      ) return;
      press.movementIntent = classifyMovementIntent(press.origin, event);
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const press = pointerPressRef.current;
      const ownsPress = press?.pointerId === event.pointerId;
      if (
        ownsPress
        && event.pointerType !== "mouse"
      ) {
        // pointerdown arms early enough to catch interleaved mousedown;
        // pointerup renews the bounded guard for mouse events grouped after
        // gesture recognition, including long presses.
        suppressCompatibilityActivation(event.currentTarget.ownerDocument);
      }
      const movementIntent = press
        ? press.movementIntent
          ?? classifyMovementIntent(press.origin, event)
        : null;
      clearPointerPress(event);
      if (
        event.currentTarget.disabled
        || event.pointerType === "mouse"
      ) return;
      const pressedHere = (
        event.isPrimary !== false
        && event.button === 0
        && ownsPress
        && press !== null
        && !movementIntent
      );
      if (!pressedHere) return;

      const rect = event.currentTarget.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) return;

      event.preventDefault();
      onActivate();
      if (pointerFocus === "release-after-activation") {
        event.currentTarget.blur();
      }
    },
    onPointerCancel: cancelPointerPress,
    onLostPointerCapture: cancelPointerPress,
    onClick(event: ReactMouseEvent<HTMLButtonElement>) {
      onActivate();
      // detail=0 identifies keyboard, assistive-technology and programmatic
      // activation. Keep their focus position; only a physical pointer close
      // should retire the target focus after the action.
      if (
        pointerFocus === "release-after-activation"
        && event.detail !== 0
      ) {
        event.currentTarget.blur();
      }
    }
  };
}

/**
 * Shared activation boundary for controls whose activation can synchronously
 * close, remove, disable, repaint or reposition the touched surface or nearby
 * hit targets.
 *
 * Touch and pen activation is committed on pointerup only while the physical
 * press stays below the shared movement-intent threshold. This prevents
 * implicit pointer capture from turning a scroll that starts on the control
 * into activation. It never selects or moves a scroll owner. Mouse, keyboard
 * and assistive technology keep the native click path. pointerFocus makes the
 * pointer focus lifecycle explicit: target follows native button ordering,
 * preserve keeps an editor focused, and release-after-activation removes a
 * physical pointer's focus after a closing action while retaining keyboard
 * focus.
 */
export const DirectActivationButton = forwardRef<
  HTMLButtonElement,
  DirectActivationButtonProps
>(function DirectActivationButton({
  onActivate,
  pointerFocus = "target",
  ...buttonProps
}, ref) {
  const activationHandlers = useDirectActivation(
    onActivate,
    pointerFocus
  );

  return (
    <button
      {...buttonProps}
      {...activationHandlers}
      ref={ref}
    />
  );
});
