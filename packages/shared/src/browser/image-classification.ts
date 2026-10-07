export const devices = ["pc", "mb"] as const;

export const brightnesses = ["dark", "light"] as const;

export type Device = (typeof devices)[number];

export type Brightness = (typeof brightnesses)[number];

export function detectDeviceFromUserAgent(userAgent: string): Device | null {
  if (!userAgent) return null;
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(userAgent)) return "pc";
  return null;
}
