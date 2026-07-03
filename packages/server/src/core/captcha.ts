import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { getRuntimeConfig } from "../config/env.js";
import { redis } from "./redis-client.js";
import { ApiError, isSecure, noStoreCacheControl } from "./http.js";

const captchaCookie = "imageshow_captcha";

const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

const captchaDifficulty = {
  stepX: 28,
  height: 50,
  fontSizeMin: 23,
  fontSizeMax: 35,
  rotationDeg: 30,
  baselineJitter: 8
};

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
  c.header("Cache-Control", noStoreCacheControl);
  return c.body(renderCaptchaSvg(code, noise_lines, noise_dots));
}

export async function verifyCaptcha(c: Context, answer: string) {
  if (!getRuntimeConfig().captcha.enabled) return;
  const id = getCookie(c, captchaCookie);
  const expected = id ? await redis.get(redisKey(id)) : null;
  if (id) await redis.del(redisKey(id));

  if (!expected || answer.trim().toUpperCase() !== expected.toUpperCase()) {
    throw new ApiError(400, "captcha_invalid", "验证码错误，请重试");
  }
}

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
