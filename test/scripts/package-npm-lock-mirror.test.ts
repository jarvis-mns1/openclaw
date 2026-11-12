import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { collectPnpmLockViolations } from "../../scripts/generate-npm-package-lock.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = tempDirs.make("openclaw-derived-npm-lock-");
  const npm = path.join(root, "source/package");
  const dependencies = { glob: "14.0.2", minimatch: "11.0.1", "ip-address": "10.7.5" };
  const json = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  json(path.join(root, "package.json"), {
    name: "lock-mirror-fixture",
    version: "1.0.0",
    dependencies: { npm: "12.2.2" },
    bundleDependencies: ["npm"],
    scripts: { check: "node scripts/crabbox-wrapper.mjs --check" },
  });
  json(path.join(root, "pnpm-workspace.yaml"), {
    overrides: { glob: "14.0.2", minimatch: "11.0.1", "ip-address": "10.7.4" },
  });
  json(path.join(root, "pnpm-lock.yaml"), {
    packages: { "npm@12.2.2": { resolution: { integrity: "sha512-upstream-not-derived" } } },
    snapshots: { "npm@12.2.2": {} },
  });
  json(path.join(npm, "package.json"), {
    name: "npm",
    version: "12.2.2",
    dependencies,
    bundleDependencies: Object.keys(dependencies),
  });
  for (const [name, version] of Object.entries(dependencies)) {
    json(path.join(npm, "node_modules", name, "package.json"), { name, version, main: "index.js" });
    writeFileSync(
      path.join(npm, "node_modules", name, "index.js"),
      "throw new Error('must not execute fixture package code');\n",
    );
  }
  const archive = path.join(root, "derived-npm.tgz");
  createTar({ cwd: path.dirname(npm), file: archive, sync: true, gzip: true }, ["package"]);
  const bytes = readFileSync(archive);
  const artifact = {
    name: "npm",
    version: "12.2.2",
    spec: "file:./derived-npm.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  return { root, npm, json, archive, artifact };
}

function run(root: string, script: string) {
  return spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: root,
        npm_config_offline: "true",
      },
    },
  );
}

function generate(root: string, artifacts: unknown[]) {
  return run(
    root,
    `import { generateNpmPackageLock } from ${JSON.stringify(new URL("../../scripts/generate-npm-package-lock.mts", import.meta.url).href)};
    process.stdout.write(generateNpmPackageLock(${JSON.stringify(root)}, {localPackageArtifacts:${JSON.stringify(artifacts)}}));`,
  );
}

function frozenInstall(input: ReturnType<typeof fixture>) {
  const patch = "synthetic source patch\n";
  const hash = createHash("sha256").update(patch).digest("hex");
  const version = `12.2.2(patch_hash=${hash})`;
  const workspace = JSON.parse(readFileSync(path.join(input.root, "pnpm-workspace.yaml"), "utf8"));
  input.json(path.join(input.root, "pnpm-workspace.yaml"), {
    ...workspace,
    patchedDependencies: { "npm@12.2.2": "npm.patch" },
  });
  writeFileSync(path.join(input.root, "npm.patch"), patch);
  const lock = JSON.parse(readFileSync(path.join(input.root, "pnpm-lock.yaml"), "utf8"));
  const frozen = {
    ...lock,
    patchedDependencies: { "npm@12.2.2": hash },
    importers: { ".": { dependencies: { npm: { specifier: "12.2.2", version } } } },
  };
  input.json(path.join(input.root, "pnpm-lock.yaml"), frozen);
  input.json(path.join(input.root, "node_modules/.pnpm/lock.yaml"), frozen);
  input.json(path.join(input.root, "node_modules/.modules.yaml"), {
    nodeLinker: "hoisted",
    virtualStoreDir: ".pnpm",
    hoistedLocations: { [`npm@${version}`]: ["node_modules/npm"] },
  });
  cpSync(input.npm, path.join(input.root, "node_modules/npm"), { recursive: true });
}

describe("derived npm lock mirror", () => {
  it("mirrors the actual corrected local npm bundle without registry substitution", () => {
    const input = fixture();
    const result = generate(input.root, [input.artifact]);
    expect(result.status, result.stderr).toBe(0);
    const lock = JSON.parse(result.stdout);
    expect(lock.packages["node_modules/npm"]).toMatchObject({
      version: "12.2.2",
      resolved: "file:derived-npm.tgz",
      integrity: input.artifact.integrity,
    });
    for (const [name, version] of Object.entries({
      glob: "14.0.2",
      minimatch: "11.0.1",
      "ip-address": "10.7.5",
    })) {
      expect(lock.packages[`node_modules/npm/node_modules/${name}`]).toMatchObject({
        version,
        inBundle: true,
      });
      expect(lock.packages[`node_modules/${name}`]).toBeUndefined();
    }
  });

  it("rejects changed local archive bytes before resolving its lock", () => {
    const input = fixture();
    writeFileSync(
      input.archive,
      Buffer.concat([readFileSync(input.archive), Buffer.from("changed")]),
    );
    const result = generate(input.root, [input.artifact]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local package artifact integrity mismatch: npm");
  });

  it.each(["version", "name", "path", "unbundled", "missing", "extra"])(
    "rejects a changed local bundled occurrence (%s)",
    (change) => {
      const input = fixture();
      const childPath = "node_modules/npm/node_modules/ip-address";
      const packages: Record<string, Record<string, unknown>> = {
        "node_modules/npm": {
          version: "12.2.2",
          integrity: input.artifact.integrity,
          resolved: "file:derived-npm.tgz",
        },
        "node_modules/npm/node_modules/glob": { version: "14.0.2", inBundle: true },
        "node_modules/npm/node_modules/minimatch": { version: "11.0.1", inBundle: true },
        [childPath]: { version: "10.7.5", inBundle: true },
      };
      if (change === "version") {
        packages[childPath].version = "10.7.4";
      }
      if (change === "name") {
        packages[childPath].name = "other";
      }
      if (change === "unbundled") {
        packages[childPath].inBundle = false;
      }
      if (change === "path") {
        packages["node_modules/ip-address"] = packages[childPath];
        delete packages[childPath];
      }
      if (change === "missing") {
        delete packages[childPath];
      }
      if (change === "extra") {
        packages["node_modules/npm/node_modules/extra"] = { version: "1.0.0", inBundle: true };
      }
      expect(() =>
        collectPnpmLockViolations(
          { packages },
          new Set(["npm@12.2.2", "ip-address@10.7.4"]),
          new Map(),
          [input.artifact],
          readFileSync(input.archive),
        ),
      ).toThrow(/local bundled package/);
    },
  );

  it("uses the frozen root patch during canonical manifest preparation and cleans temporary archives", () => {
    const input = fixture();
    frozenInstall(input);
    const original = readFileSync(path.join(input.root, "package.json"), "utf8");
    const result = run(
      input.root,
      `import { preparePackageManifest, restorePackageManifest } from ${JSON.stringify(new URL("../../scripts/package-manifest.mjs", import.meta.url).href)};
      const changed = await preparePackageManifest(${JSON.stringify(input.root)});
      const restored = await restorePackageManifest(${JSON.stringify(input.root)});
      process.stdout.write(JSON.stringify({changed, restored}));`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ changed: true, restored: true });
    expect(readFileSync(path.join(input.root, "package.json"), "utf8")).toBe(original);
    expect(
      readdirSync(input.root).filter((name) => name.startsWith(".openclaw-patched-dependencies-")),
    ).toEqual([]);
  });

  it("refuses a mismatched installed patch before modifying the canonical manifest", () => {
    const input = fixture();
    frozenInstall(input);
    writeFileSync(path.join(input.root, "npm.patch"), "uninstalled change\n");
    const original = readFileSync(path.join(input.root, "package.json"), "utf8");
    const result = run(
      input.root,
      `import { preparePackageManifest } from ${JSON.stringify(new URL("../../scripts/package-manifest.mjs", import.meta.url).href)};
      await preparePackageManifest(${JSON.stringify(input.root)});`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a matching frozen pnpm install");
    expect(readFileSync(path.join(input.root, "package.json"), "utf8")).toBe(original);
    expect(
      existsSync(path.join(input.root, ".artifacts/package-manifest/package.json.prepack-backup")),
    ).toBe(false);
  });
});
