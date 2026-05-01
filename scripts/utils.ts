/**
 * Shared helpers for local and CI scripts.
 * Keep script-only environment, SST output, and JSON parsing utilities here.
 */

import { readFileSync } from "node:fs";

export function optionalScriptEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function requireScriptEnv(name: string): string {
  const value = optionalScriptEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function outputOrEnv(envName: string, outputName: string): string {
  const explicit = optionalScriptEnv(envName);
  if (explicit) {
    return explicit;
  }

  const outputs = readSstOutputs();
  const value = outputs[outputName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${envName} and .sst output ${outputName}`);
  }

  return value;
}

export function readSstOutputs(): Record<string, unknown> {
  try {
    const raw = readFileSync(".sst/outputs.json", "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`Unable to read .sst/outputs.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}\n${text}`);
  }
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
