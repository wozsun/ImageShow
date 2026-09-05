export type PointerMagnetOptions = {
  maximumAngleDegrees: number;
  maximumShadowOffsetPixels: number;
  useLayoutDimensions?: boolean;
};

type PointerMagnetInput = {
  clientX: number;
  clientY: number;
  pointerType: string;
};

export type PointerMagnetTransform = {
  angleDegrees: number;
  axisX: number;
  axisY: number;
  normalizedX: number;
  normalizedY: number;
  edgeStrength: number;
  shadowX: number;
  shadowY: number;
};

const magnetProperties = {
  angle: "--public-card-magnet-angle",
  axisX: "--public-card-magnet-axis-x",
  axisY: "--public-card-magnet-axis-y",
  shadowX: "--public-card-magnet-shadow-x",
  shadowY: "--public-card-magnet-shadow-y",
  lightX: "--public-card-magnet-light-x",
  lightY: "--public-card-magnet-light-y",
  lightStrength: "--public-card-magnet-light-strength"
} as const;

export function resetPointerMagnet(element: HTMLElement) {
  element.style.setProperty(magnetProperties.axisX, "0");
  element.style.setProperty(magnetProperties.axisY, "0");
  element.style.setProperty(magnetProperties.angle, "0deg");
  element.style.setProperty(magnetProperties.shadowX, "0px");
  element.style.setProperty(magnetProperties.shadowY, "0px");
  element.style.setProperty(magnetProperties.lightStrength, "0");
}

export function calculatePointerMagnet(
  normalizedXInput: number,
  normalizedYInput: number,
  options: PointerMagnetOptions
): PointerMagnetTransform {
  const normalizedX = Math.max(-1, Math.min(1, normalizedXInput));
  const normalizedY = Math.max(-1, Math.min(1, normalizedYInput));
  const rawDistance = Math.hypot(normalizedX, normalizedY);
  const strength = Math.min(1, rawDistance);
  const axisDivisor = rawDistance || 1;
  return {
    angleDegrees: strength * options.maximumAngleDegrees,
    axisX: normalizedY / axisDivisor,
    axisY: -normalizedX / axisDivisor,
    normalizedX,
    normalizedY,
    edgeStrength: Math.max(Math.abs(normalizedX), Math.abs(normalizedY)) ** 2,
    shadowX: normalizedX * options.maximumShadowOffsetPixels,
    shadowY: normalizedY * options.maximumShadowOffsetPixels
  };
}

export function applyPointerMagnet(
  element: HTMLElement,
  boundsElement: HTMLElement,
  pointer: PointerMagnetInput,
  options: PointerMagnetOptions
) {
  if (pointer.pointerType !== "mouse") return false;
  const bounds = boundsElement.getBoundingClientRect();
  const width = options.useLayoutDimensions
    ? boundsElement.offsetWidth
    : bounds.width;
  const height = options.useLayoutDimensions
    ? boundsElement.offsetHeight
    : bounds.height;
  const offsetParent = boundsElement.offsetParent;
  const layoutOffsetParent = options.useLayoutDimensions
    && offsetParent instanceof HTMLElement
    ? offsetParent
    : null;
  const offsetParentBounds = layoutOffsetParent
    ? layoutOffsetParent.getBoundingClientRect()
    : null;
  const centerX = offsetParentBounds
    ? offsetParentBounds.left
      + layoutOffsetParent!.clientLeft
      + boundsElement.offsetLeft
      + width / 2
    : bounds.left + bounds.width / 2;
  const centerY = offsetParentBounds
    ? offsetParentBounds.top
      + layoutOffsetParent!.clientTop
      + boundsElement.offsetTop
      + height / 2
    : bounds.top + bounds.height / 2;
  const transform = calculatePointerMagnet(
    (pointer.clientX - centerX) / (width / 2),
    (pointer.clientY - centerY) / (height / 2),
    options
  );
  element.style.setProperty(
    magnetProperties.axisX,
    String(transform.axisX)
  );
  element.style.setProperty(
    magnetProperties.axisY,
    String(transform.axisY)
  );
  element.style.setProperty(
    magnetProperties.angle,
    `${transform.angleDegrees}deg`
  );
  element.style.setProperty(
    magnetProperties.shadowX,
    `${transform.shadowX}px`
  );
  element.style.setProperty(
    magnetProperties.shadowY,
    `${transform.shadowY}px`
  );
  element.style.setProperty(magnetProperties.lightX, `${(transform.normalizedX + 1) * 50}%`);
  element.style.setProperty(magnetProperties.lightY, `${(transform.normalizedY + 1) * 50}%`);
  element.style.setProperty(magnetProperties.lightStrength, String(transform.edgeStrength));
  return true;
}
