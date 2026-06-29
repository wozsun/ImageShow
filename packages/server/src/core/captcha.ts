// Simple alphanumeric login CAPTCHA. issueCaptcha() makes a short code, stores it in Redis
// under a random id (carried in a short-lived cookie), and returns a noisy SVG image of the
// code; verifyCaptcha() consumes that id on login. The code is one-time — deleted the moment
// it's checked — so every login attempt needs a freshly fetched captcha, which is the point:
// it caps automated credential stuffing before a guess ever reaches the password check.
//
// Code length and challenge lifetime are runtime config (config.json captcha.*); the visual
// difficulty (captchaDifficulty below) is a code-front constant — tune it here, not in config.
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { getRuntimeConfig } from "../config/env.js";
import { redis } from "./redis.js";
import { ApiError, isSecure } from "./http.js";

const captchaCookie = "imageshow_captcha";
// Mixed upper/lower case plus digits. Verification ignores case (see verifyCaptcha), so mixing
// case only adds visual variety that trips up naive OCR — it doesn't shrink the guess space.
// Skip visually ambiguous glyphs in every case — I/L/O (upper), i/l/o (lower) and 0/1 — so a
// legible image is never unfairly rejected.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

// Visual geometry of the rendered challenge — tune here (code-front). The two noise *counts*
// (distractor lines / speckle dots) are runtime config instead (config.json captcha.noise_*),
// since they're the difficulty knobs an operator is most likely to want to tweak.
const captchaDifficulty = {
  stepX: 28,          // horizontal spacing between characters (px)
  height: 50,         // image height (px) — tall enough for lowercase descenders (g/p/q/y/j)
  fontSizeMin: 23,    // each character's font size is randomised in this range (px)
  fontSizeMax: 35,
  rotationDeg: 30,    // max absolute per-character rotation (degrees)
  baselineJitter: 8   // max vertical wobble of each character from the centre line (px)
};
// Glyph / noise colours — a spread of dark, saturated hues that stay legible on the light panel.
const captchaColors = [
  "#1f6feb", "#0f7b55", "#b4690e", "#7a3ea3", "#c0392b", "#2b6cb0",
  "#0b6e6e", "#9d174d", "#3730a3", "#15803d", "#9a3412", "#5b21b6"
];

function redisKey(id: string) {
  return `imageshow:captcha:${id}`;
}

function randomCode(length: number) {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) code += codeAlphabet[bytes[i] % codeAlphabet.length];
  return code;
}

// Issues a fresh challenge: stores the code keyed by a new random id (set in the cookie) and
// returns the rendered SVG. Uses c.body() so the Set-Cookie (and no-store) survive on the
// response. Any previous id is simply left to expire in Redis.
export async function issueCaptcha(c: Context) {
  const { code_length, ttl_seconds, noise_lines, noise_dots } = getRuntimeConfig().captcha;
  const id = randomBytes(16).toString("base64url");
  const code = randomCode(code_length);
  await redis.set(redisKey(id), code, "EX", ttl_seconds);
  setCookie(c, captchaCookie, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: ttl_seconds
  });
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(renderCaptchaSvg(code, noise_lines, noise_dots));
}

// Consumes the captcha tied to the request's cookie and checks the answer (case-insensitive).
// One-time: the stored code is deleted whether or not it matches, so a wrong or replayed
// answer forces a new captcha. Throws 400 on any mismatch/expiry.
export async function verifyCaptcha(c: Context, answer: string) {
  if (!getRuntimeConfig().captcha.enabled) return; // captcha turned off (config.json captcha.enabled)
  const id = getCookie(c, captchaCookie);
  const expected = id ? await redis.get(redisKey(id)) : null;
  if (id) await redis.del(redisKey(id));
  // Case-insensitive: uppercase both sides so a lowercase glyph in the code (the alphabet is
  // mixed-case) still matches whatever case the user typed.
  if (!expected || answer.trim().toUpperCase() !== expected.toUpperCase()) {
    throw new ApiError(400, "captcha_invalid", "验证码错误，请重试");
  }
}

// Renders the code as an SVG sized to the code length: a flat panel, distractor lines and
// speckle dots behind the glyphs, and each character centred on its slot but jittered in
// vertical position, rotation, size and colour so it isn't trivially machine-readable. Code
// characters are A–Z/a–z/2–9 only, so no XML escaping is needed.
function renderCaptchaSvg(code: string, noiseLines: number, noiseDots: number): string {
  const d = captchaDifficulty;
  const padX = 14;
  const width = padX * 2 + code.length * d.stepX;
  const height = d.height;
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  const pick = () => captchaColors[Math.floor(Math.random() * captchaColors.length)];

  const lines = Array.from({ length: noiseLines }, () =>
    `<line x1="${rand(0, width).toFixed(1)}" y1="${rand(0, height).toFixed(1)}" x2="${rand(0, width).toFixed(1)}" y2="${rand(0, height).toFixed(1)}" stroke="${pick()}" stroke-width="1" opacity="0.45"/>`
  ).join("");

  const dots = Array.from({ length: noiseDots }, () =>
    `<circle cx="${rand(0, width).toFixed(1)}" cy="${rand(0, height).toFixed(1)}" r="${rand(0.6, 1.8).toFixed(1)}" fill="${pick()}" opacity="0.5"/>`
  ).join("");

  const chars = [...code].map((ch, index) => {
    const fontSize = rand(d.fontSizeMin, d.fontSizeMax);
    const x = padX + d.stepX / 2 + index * d.stepX;
    const y = height / 2 + fontSize / 3 + rand(-d.baselineJitter, d.baselineJitter);
    const rotate = rand(-d.rotationDeg, d.rotationDeg);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${pick()}" font-size="${fontSize.toFixed(0)}" font-family="monospace" font-weight="700" text-anchor="middle" transform="rotate(${rotate.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f1f3f6"/>${lines}${dots}${chars}</svg>`;
}
