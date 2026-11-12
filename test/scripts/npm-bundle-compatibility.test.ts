import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const require = createRequire(import.meta.url);
const npmRoot = path.dirname(require.resolve("npm/package.json"));
const npmCli = path.join(npmRoot, "bin/npm-cli.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves npm workspace selection, local packing and offline installation", () => {
  const root = tempDirs.make("npm-bundle-compatibility-");
  const home = path.join(root, "home");
  const config = path.join(root, "user.npmrc");
  const globalConfig = path.join(root, "global.npmrc");
  mkdirSync(home);
  writeFileSync(config, "");
  writeFileSync(globalConfig, "");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_cache: path.join(root, "cache"),
  };
  function npm(cwd: string, ...args: string[]) {
    const result = spawnSync(
      process.execPath,
      [npmCli, ...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd, env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }
  function fixture(directory: string, manifest: Record<string, unknown>) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
  }

  const workspaces = path.join(root, "workspace");
  fixture(workspaces, {
    name: "workspace-root",
    private: true,
    workspaces: ["packages/*", "!packages/excluded"],
  });
  for (const name of ["alpha", "beta", "excluded"]) {
    fixture(path.join(workspaces, "packages", name), {
      name: `fixture-${name}`,
      version: "1.0.0",
    });
  }
  expect(JSON.parse(npm(workspaces, "pkg", "get", "name", "--workspaces", "--json"))).toEqual({
    "fixture-alpha": { name: "fixture-alpha" },
    "fixture-beta": { name: "fixture-beta" },
  });
  expect(
    JSON.parse(npm(workspaces, "pkg", "get", "name", "--workspace=packages/alpha", "--json")),
  ).toEqual({ "fixture-alpha": { name: "fixture-alpha" } });

  const payload = path.join(root, "payload");
  fixture(payload, {
    name: "fixture-payload",
    version: "1.0.0",
    main: "index.js",
    files: ["index.js"],
    scripts: { prepack: "exit 91", install: "exit 92" },
  });
  writeFileSync(path.join(payload, "index.js"), "module.exports = 42;\n");
  writeFileSync(path.join(payload, "excluded.txt"), "not for publication\n");
  const packed = JSON.parse(npm(payload, "pack", "--json", `--pack-destination=${root}`));
  const entries = Array.isArray(packed) ? packed : Object.values(packed);
  expect(entries).toHaveLength(1);
  const entry = entries[0] as { filename: string; files: Array<{ path: string }> };
  expect(entry.files.map((file) => file.path).sort()).toEqual(["index.js", "package.json"]);
  const archive = path.join(root, entry.filename);
  expect(existsSync(archive)).toBe(true);

  const consumer = path.join(root, "consumer");
  fixture(consumer, { name: "fixture-consumer", version: "1.0.0", private: true });
  npm(consumer, "install", archive);
  npm(consumer, "ci");
  expect(
    JSON.parse(
      readFileSync(path.join(consumer, "node_modules/fixture-payload/package.json"), "utf8"),
    ),
  ).toMatchObject({ name: "fixture-payload", version: "1.0.0" });
  expect(readFileSync(path.join(consumer, "node_modules/fixture-payload/index.js"), "utf8")).toBe(
    "module.exports = 42;\n",
  );
  expect(existsSync(path.join(consumer, "node_modules/fixture-payload/excluded.txt"))).toBe(false);
});
