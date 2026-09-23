/**
 * Minimal terminal formatting for the CLI.
 */

import type { DiffEntry } from "../sync.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const UNDERLINE = "\x1b[4m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const LABEL_BG_GREEN = "\x1b[42m\x1b[30m\x1b[1m";
const LABEL_BG_YELLOW = "\x1b[43m\x1b[30m\x1b[1m";

export interface FormatOptions {
  color?: boolean;
  now?: Date;
  /** Stream the text is written to, which decides whether it is a terminal. */
  stream?: "stdout" | "stderr";
}

export interface DeploymentTarget {
  project: string;
  stage: string;
  dashboardUrl: string;
}

/**
 * Where the next command acts, read from `.env.local`, the shell and the stored
 * login only. Help prints it, so it must never cost a network call.
 */
export interface HelpContext {
  loggedIn: boolean;
  /** Org name stored with the login; unknown for a BROODS_TOKEN login. */
  org?: string;
  /** Unset until `broods dev` or `--project` picks one. */
  project?: string;
  /** Folder name `broods dev` would suggest when no project is set. */
  projectGuess: string;
  server: string;
  stage: string;
}

/**
 * One row of a picker or listing, marked with `*` and highlighted when it is the
 * entry already in use, the one an empty answer keeps.
 */
export function formatChoiceRow(
  text: string,
  current: boolean,
  options: FormatOptions = {},
): string {
  const row = `${current ? "*" : " "} ${text}`;

  return current ? paint(row, `${BOLD}${CYAN}`, shouldUseColor(options)) : row;
}

/** The `org / project / stage / server` block at the top of bare `broods`. */
export function formatContext(
  context: HelpContext,
  options: FormatOptions = {},
): string[] {
  const color = shouldUseColor(options);
  const label = (name: string): string => paint(name.padEnd(9), DIM, color);
  const org = !context.loggedIn
    ? paint("not logged in", YELLOW, color)
    : (context.org ?? paint("unknown, run broods whoami", DIM, color));
  const project =
    context.project ??
    `none ${paint(`(${context.projectGuess} from folder name)`, DIM, color)}`;

  return [
    `  ${label("org")}${org}`,
    `  ${label("project")}${project}`,
    `  ${label("stage")}${paintStage(context.stage, color)}`,
    `  ${label("server")}${context.server}`,
  ];
}

export function formatDeploymentTarget(
  target: DeploymentTarget,
  options: FormatOptions = {},
): string {
  const color = shouldUseColor(options);
  // `dev` syncs whatever stage BROODS_STAGE/--stage resolves to, so the banner
  // has to name that stage. A green badge is reserved for Development; anything
  // else gets a yellow one so syncing Production never looks routine.
  const stageLabel = stageDisplayName(target.stage);
  const development = stageLabel === "Development";
  const bar = paint("▌", development ? GREEN : YELLOW, color);
  const label = color
    ? `${development ? LABEL_BG_GREEN : LABEL_BG_YELLOW} ${stageLabel} ${RESET}`
    : `[${stageLabel}]`;
  const dashboardText = color
    ? paint("dashboard", UNDERLINE, color)
    : "dashboard";
  const deepLink = `${target.dashboardUrl}?project=${encodeURIComponent(target.project)}&stage=${encodeURIComponent(target.stage)}`;
  const url = paint(deepLink, `${DIM}${UNDERLINE}`, color);

  return [
    `${bar} Syncing ${stageLabel}: ${paint(target.project, "", color)}`,
    `${bar} ${label} ${target.stage} (${dashboardText})`,
    `${bar} ${paint("└─", DIM, color)} ${url}`,
  ].join("\n");
}

export function formatDiffEntries(
  entries: DiffEntry[],
  options: FormatOptions = {},
): string[] {
  const color = shouldUseColor(options);

  return entries.map((entry) => {
    const marker = formatDiffMarker(entry.operation, color);
    if (entry.operation === "rename" && entry.previousName) {
      return `  ${marker} ${entry.kind}:${entry.previousName} -> ${entry.name}`;
    }

    return `  ${marker} ${entry.kind}:${entry.name}`;
  });
}

/**
 * One-line summary of the env vars `dev` pushed from `.env.local` to the cloud
 * stage, e.g. `▌ ↑ Synced 2 env var(s) from .env.local: OPENAI_API_KEY, …`.
 */
export function formatEnvSync(
  names: string[],
  options: FormatOptions = {},
): string {
  const color = shouldUseColor(options);
  const bar = paint("▌", GREEN, color);
  const arrow = paint("↑", GREEN, color);

  return `${bar} ${arrow} Synced ${names.length} env var(s) from .env.local: ${names.join(", ")}`;
}

/** `✖ message`, red mark on the first line only so a trailing help page stays plain. */
export function formatError(
  message: string,
  options: FormatOptions = {},
): string {
  return `${paint("✖", RED, shouldUseColor(options))} ${message}`;
}

/** Suggested commands, name then a dimmed reason, aligned in one column. */
export function formatNext(
  entries: readonly (readonly [string, string])[],
  options: FormatOptions = {},
): string[] {
  const color = shouldUseColor(options);
  const width = Math.max(...entries.map(([command]) => command.length)) + 2;

  return entries.map(
    ([command, reason]) =>
      `  ${command.padEnd(width)}${paint(reason, DIM, color)}`,
  );
}

export function formatReadyLine(
  durationMs: number,
  options: FormatOptions = {},
): string {
  const time = (options.now ?? new Date()).toTimeString().slice(0, 8);

  return `${paint("✔", GREEN, shouldUseColor(options))} ${time} Resources ready! (${formatDuration(durationMs)})`;
}

export function formatSuccess(
  message: string,
  options: FormatOptions = {},
): string {
  return `${paint("✔", GREEN, shouldUseColor(options))} ${message}`;
}

/**
 * What a command page acts on right now, e.g. `now  my-app → production`.
 * `note` explains a target that differs from the current stage.
 */
export function formatTarget(
  project: string,
  stage: string,
  note: string | undefined,
  options: FormatOptions = {},
): string {
  const color = shouldUseColor(options);
  const suffix = note ? `  ${paint(`(${note})`, DIM, color)}` : "";

  return `  ${paint("now", DIM, color)}  ${project} → ${paintStage(stage, color)}${suffix}`;
}

export function formatWarning(
  message: string,
  options: FormatOptions = {},
): string {
  return paint(`! ${message}`, YELLOW, shouldUseColor(options));
}

export function printDeploymentTarget(target: DeploymentTarget): void {
  console.error(formatDeploymentTarget(target));
}

export function printDiffEntries(entries: DiffEntry[]): void {
  for (const line of formatDiffEntries(entries)) console.log(line);
}

export function printEnvSync(names: string[]): void {
  console.error(formatEnvSync(names));
}

export function printError(message: string): void {
  console.error(formatError(message, { stream: "stderr" }));
}

export function printReadyLine(durationMs: number): void {
  console.error(formatReadyLine(durationMs));
}

export function printSuccess(message: string): void {
  console.log(formatSuccess(message, { stream: "stdout" }));
}

export function printWarning(message: string): void {
  console.log(formatWarning(message, { stream: "stdout" }));
}

function formatDiffMarker(
  operation: DiffEntry["operation"],
  color: boolean,
): string {
  if (operation === "create") return `[${paint("+", GREEN, color)}]`;
  if (operation === "rename") return `[${paint("~", YELLOW, color)}]`;
  if (operation === "update") return `[${paint("*", CYAN, color)}]`;

  return `[${paint("-", RED, color)}]`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;

  return `${Math.max(ms, 0).toFixed(1)}ms`;
}

function paint(value: string, style: string, color: boolean): string {
  return color ? `${style}${value}${RESET}` : value;
}

// Green for development, yellow for anything else, matching the dev banner.
function paintStage(stage: string, color: boolean): string {
  const development = stageDisplayName(stage) === "Development";

  return paint(stage, development ? GREEN : YELLOW, color);
}

function shouldUseColor(options: FormatOptions): boolean {
  if (options.color !== undefined) return options.color;
  if (Object.hasOwn(process.env, "NO_COLOR")) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;

  const stream = options.stream === "stdout" ? process.stdout : process.stderr;

  return stream.isTTY && process.env.TERM !== "dumb";
}

/**
 * The stage name as the backend stores it: `development` and `production` are
 * reserved and always canonicalize, every other name is kept verbatim.
 */
function stageDisplayName(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  if (normalized === "development") return "Development";
  if (normalized === "production") return "Production";

  return stage.trim();
}
