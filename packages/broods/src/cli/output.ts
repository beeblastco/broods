/**
 * Minimal terminal formatting for the CLI.
 */

import type { DiffEntry } from "../sync.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const UNDERLINE = "\x1b[4m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const LABEL_BG_GREEN = "\x1b[42m\x1b[30m\x1b[1m";

export interface FormatOptions {
  color?: boolean;
  now?: Date;
}

export interface DeploymentTarget {
  project: string;
  environment: string;
  dashboardUrl: string;
}

export function formatDeploymentTarget(
  target: DeploymentTarget,
  options: FormatOptions = {},
): string {
  const color = shouldUseColor(options);
  const bar = paint("▌", GREEN, color);
  const label = color ? `${LABEL_BG_GREEN} Development ${RESET}` : "[Development]";
  const dashboardText = color ? paint("dashboard", UNDERLINE, color) : "dashboard";
  const deepLink = `${target.dashboardUrl}?project=${encodeURIComponent(target.project)}&env=${encodeURIComponent(target.environment)}`;
  const url = paint(deepLink, `${DIM}${UNDERLINE}`, color);

  return [
    `${bar} Syncing Development: ${paint(target.project, "", color)}`,
    `${bar} ${label} ${target.environment} (${dashboardText})`,
    `${bar} ${paint("└─", DIM, color)} ${url}`,
  ].join("\n");
}

export function formatReadyLine(durationMs: number, options: FormatOptions = {}): string {
  const time = (options.now ?? new Date()).toTimeString().slice(0, 8);
  return `${paint("✔", GREEN, shouldUseColor(options))} ${time} Resources ready! (${formatDuration(durationMs)})`;
}

/**
 * One-line summary of the env vars `dev` pushed from `.env.local` to the cloud
 * environment, e.g. `▌ ↑ Synced 2 env var(s) from .env.local: OPENAI_API_KEY, …`.
 */
export function formatEnvSync(names: string[], options: FormatOptions = {}): string {
  const color = shouldUseColor(options);
  const bar = paint("▌", GREEN, color);
  const arrow = paint("↑", GREEN, color);
  return `${bar} ${arrow} Synced ${names.length} env var(s) from .env.local: ${names.join(", ")}`;
}

export function formatDiffEntries(entries: DiffEntry[], options: FormatOptions = {}): string[] {
  const color = shouldUseColor(options);

  return entries.map((entry) => {
    const marker = formatDiffMarker(entry.operation, color);
    if (entry.operation === "rename" && entry.previousName) {
      return `  ${marker} ${entry.kind}:${entry.previousName} -> ${entry.name}`;
    }
    return `  ${marker} ${entry.kind}:${entry.name}`;
  });
}

export function formatWarning(message: string, options: FormatOptions = {}): string {
  return paint(message, YELLOW, shouldUseColor(options));
}

export function printReadyLine(durationMs: number): void {
  console.error(formatReadyLine(durationMs));
}

export function printDeploymentTarget(target: DeploymentTarget): void {
  console.error(formatDeploymentTarget(target));
}

export function printEnvSync(names: string[]): void {
  console.error(formatEnvSync(names));
}

export function printDiffEntries(entries: DiffEntry[]): void {
  for (const line of formatDiffEntries(entries)) console.log(line);
}

export function printWarning(message: string): void {
  console.log(formatWarning(message));
}

function shouldUseColor(options: FormatOptions): boolean {
  if (options.color !== undefined) return options.color;
  if (Object.hasOwn(process.env, "NO_COLOR")) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return process.stderr.isTTY && process.env.TERM !== "dumb";
}

function paint(value: string, style: string, color: boolean): string {
  return color ? `${style}${value}${RESET}` : value;
}

function formatDiffMarker(operation: DiffEntry["operation"], color: boolean): string {
  if (operation === "create") return `[${paint("+", GREEN, color)}]`;
  if (operation === "rename") return `[${paint("~", YELLOW, color)}]`;
  if (operation === "update") return `[${paint("*", CYAN, color)}]`;
  return `[${paint("-", RED, color)}]`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.max(ms, 0).toFixed(1)}ms`;
}
