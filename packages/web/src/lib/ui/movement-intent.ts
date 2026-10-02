export type ClientPoint = {
  clientX: number;
  clientY: number;
};

export type MovementIntent = "horizontal" | "vertical";

const movementIntentThreshold = 5;

/**
 * The single movement-intent boundary shared by touch and pointer owners.
 * This pure classifier owns neither gesture lifecycle nor any resulting
 * focus, activation or scrolling. Axis ties are vertical so a diagonal press
 * never acquires horizontal scrolling merely because a viewport is present.
 */
export function classifyMovementIntent(
  origin: ClientPoint,
  current: ClientPoint
): MovementIntent | null {
  const deltaX = current.clientX - origin.clientX;
  const deltaY = current.clientY - origin.clientY;
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < movementIntentThreshold) return null;
  return Math.abs(deltaX) > Math.abs(deltaY)
    ? "horizontal"
    : "vertical";
}

/** Finds the tracked touch so a gesture owner keeps following one finger. */
export function touchWithIdentifier(touches: TouchList, identifier: number) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch.identifier === identifier) return touch;
  }
  return null;
}
