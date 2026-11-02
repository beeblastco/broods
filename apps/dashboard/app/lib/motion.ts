// Mirrors the `--transition-duration-*` tokens in globals.css.
export const MOTION_MS = { fast: 120, base: 160, slow: 200 } as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
