import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isShellOwnedEnv,
  loadBroodsRuntimeConfig,
} from "../src/runtime-config.ts";

test("loadBroodsRuntimeConfig picks up .env.local edits for vars not in real env", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-cache-"));
  try {
    // Unique var name guaranteed not to be in the real shell environment
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_A=value-a\n",
      "utf8",
    );
    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_A).toBe("value-a");

    // Overwrite the variable in .env.local
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_A=value-b\n",
      "utf8",
    );

    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_A).toBe("value-b");
  } finally {
    delete process.env.BROODS_TEST_VAR_A;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loadBroodsRuntimeConfig with BROODS_RELOAD_ENV=1 always overwrites", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-cache-"));
  const originalReload = process.env.BROODS_RELOAD_ENV;
  try {
    process.env.BROODS_RELOAD_ENV = "1";
    // Even if the var was set before, forceReload bypasses the guard
    process.env.BROODS_TEST_VAR_C = "old";
    await writeFile(join(cwd, ".env.local"), "BROODS_TEST_VAR_C=new\n", "utf8");

    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_C).toBe("new");

    // Change it again — forceReload should still overwrite
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_C=newer\n",
      "utf8",
    );

    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_C).toBe("newer");
  } finally {
    delete process.env.BROODS_TEST_VAR_C;
    if (originalReload === undefined) delete process.env.BROODS_RELOAD_ENV;
    else process.env.BROODS_RELOAD_ENV = originalReload;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loadBroodsRuntimeConfig does not re-read unchanged .env.local", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-cache-"));
  try {
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_E=same\n",
      "utf8",
    );
    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_E).toBe("same");

    // Re-write with same content — value stays the same
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_E=same\n",
      "utf8",
    );

    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_E).toBe("same");
  } finally {
    delete process.env.BROODS_TEST_VAR_E;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loadBroodsRuntimeConfig picks up .env (not just .env.local) edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-cache-"));
  try {
    await writeFile(
      join(cwd, ".env"),
      "BROODS_TEST_VAR_F=from-dotenv\n",
      "utf8",
    );
    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_F).toBe("from-dotenv");

    await writeFile(
      join(cwd, ".env"),
      "BROODS_TEST_VAR_F=from-dotenv-updated\n",
      "utf8",
    );

    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_F).toBe("from-dotenv-updated");
  } finally {
    delete process.env.BROODS_TEST_VAR_F;
    await rm(cwd, { recursive: true, force: true });
  }
});

// `stage use` / `org use` rewrite `.env.local`, but a shell export wins over the
// file on the next command, so the CLI has to tell the two apart and warn.
// Bun loads `.env.local` into process.env before user code runs, so this cannot
// be answered from a startup snapshot — only by reading the file back.
test("isShellOwnedEnv separates a shell export from a .env.local value", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-owner-"));
  const saved = {
    file: process.env.BROODS_TEST_FROM_FILE,
    shell: process.env.BROODS_TEST_FROM_SHELL,
    shadow: process.env.BROODS_TEST_SHADOWED,
  };
  try {
    await writeFile(
      join(cwd, ".env.local"),
      [
        "BROODS_TEST_FROM_FILE=from-file",
        "BROODS_TEST_SHADOWED=from-file",
        "",
      ].join("\n"),
      "utf8",
    );
    loadBroodsRuntimeConfig(cwd);
    // An export the shell made after the file was written still wins.
    process.env.BROODS_TEST_SHADOWED = "from-shell";
    process.env.BROODS_TEST_FROM_SHELL = "from-shell";

    expect(isShellOwnedEnv("BROODS_TEST_FROM_FILE", cwd)).toBe(false);
    expect(isShellOwnedEnv("BROODS_TEST_SHADOWED", cwd)).toBe(true);
    expect(isShellOwnedEnv("BROODS_TEST_FROM_SHELL", cwd)).toBe(true);
    expect(isShellOwnedEnv("BROODS_TEST_NEVER_SET", cwd)).toBe(false);
  } finally {
    restoreEnv("BROODS_TEST_FROM_FILE", saved.file);
    restoreEnv("BROODS_TEST_FROM_SHELL", saved.shell);
    restoreEnv("BROODS_TEST_SHADOWED", saved.shadow);
    await rm(cwd, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("loadBroodsRuntimeConfig cleans up cache entry when file is deleted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-cache-"));
  try {
    await writeFile(
      join(cwd, ".env.local"),
      "BROODS_TEST_VAR_G=exists\n",
      "utf8",
    );
    loadBroodsRuntimeConfig(cwd);
    expect(process.env.BROODS_TEST_VAR_G).toBe("exists");

    await rm(join(cwd, ".env.local"));

    // Next call should not error — the deleted file's cache entry is removed
    loadBroodsRuntimeConfig(cwd);
  } finally {
    delete process.env.BROODS_TEST_VAR_G;
    await rm(cwd, { recursive: true, force: true });
  }
});
