"use client";

/** Deterministic dithered avatar generated from a seed string (e.g. an agent name). */
import type { CSSProperties } from "react";

const GRID = 34;
const SIZE = 200;
const SCALE = 6;
const TRANSLATE_Y = 3;

export type DitherAvatarProps = {
  seed: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
};

const BAYER_4X4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }

  return Math.abs(h);
}

function hashMultiple(str: string, count: number): number[] {
  const results: number[] = [];
  for (let i = 0; i < count; i++) {
    results.push(hashString(str + ":" + i));
  }

  return results;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function generateDensityGrid(seed: string): number[][] {
  const hashes = hashMultiple(seed, 2);
  const angle = (hashes[0] % 360) * (Math.PI / 180);
  const offset = ((hashes[1] % 100) / 100) * 0.4 - 0.2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const grid: number[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: number[] = [];
    for (let x = 0; x < GRID; x++) {
      const nx = (x / (GRID - 1)) * 2 - 1;
      const ny = (y / (GRID - 1)) * 2 - 1;
      const projected = nx * cosA + ny * sinA;
      const density = (projected + 1 + offset) / 2;
      row.push(Math.max(0, Math.min(1, density)));
    }
    grid.push(row);
  }

  return grid;
}

function dither(density: number[][]): number[][] {
  const result: number[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: number[] = [];
    for (let x = 0; x < GRID; x++) {
      const bayer = BAYER_4X4[y % 4][x % 4] / 16;
      row.push(density[y][x] >= bayer ? 1 : 0);
    }
    result.push(row);
  }

  return result;
}

function bitmapToPath(pixels: number[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < GRID; y++) {
    const row = pixels[y];
    const segments: { start: number; len: number }[] = [];
    let x = 0;

    while (x < GRID) {
      if (row[x] === 1) {
        const start = x;
        while (x < GRID && row[x] === 1) x++;
        segments.push({ start, len: x - start });
      } else {
        x++;
      }
    }

    if (segments.length === 0) continue;

    let pathStr = `M${segments[0].start} ${y}`;
    let cursorX = segments[0].start;
    pathStr += `h${segments[0].len}`;
    cursorX += segments[0].len;

    for (let i = 1; i < segments.length; i++) {
      const gap = segments[i].start - cursorX;
      pathStr += `m${gap} 0h${segments[i].len}`;
      cursorX = segments[i].start + segments[i].len;
    }

    parts.push(pathStr);
  }

  return parts.join("");
}

export function generateColors(seed: string): { fill: string; stroke: string } {
  const [hueHash] = hashMultiple(seed, 1);
  const hue = hueHash % 360;

  return {
    fill: hslToHex(hue, 85, 30),
    stroke: hslToHex(hue, 90, 65),
  };
}

export function generateDitherAvatar(seed: string): string {
  const { fill, stroke } = generateColors(seed);
  const density = generateDensityGrid(seed);
  const pixels = dither(density);
  const path = bitmapToPath(pixels);

  return [
    `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">`,
    `<rect width="${SIZE}" height="${SIZE}" fill="${fill}"/>`,
    `<path fill="none" stroke="${stroke}" transform="translate(0,${TRANSLATE_Y})scale(${SCALE})" d="${path}"/>`,
    `</svg>`,
  ].join("");
}

export function ditherAvatarDataUri(seed: string): string {
  const svg = generateDitherAvatar(seed);

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const AVATAR_SIZE = SIZE;
export const AVATAR_GRID = GRID;

/** Renders the seeded dither avatar as a rounded `<img>`. */
export function DitherAvatar({
  seed,
  size = 40,
  className,
  style,
}: DitherAvatarProps) {
  const uri = ditherAvatarDataUri(seed);

  return (
    // Inline SVG data-URI — nothing for next/image to optimize.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={uri}
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: "50%", ...style }}
    />
  );
}

/** Renders the seeded dither avatar as an inline `<svg>` (crisp at any scale). */
export function DitherAvatarSVG({
  seed,
  size = 40,
  className,
  style,
}: DitherAvatarProps) {
  const svg = generateDitherAvatar(seed);
  const inner = svg
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>/, "")
    .trim();

  return (
    <svg
      viewBox={`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      style={{ borderRadius: "50%", ...style }}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
