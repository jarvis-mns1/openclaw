import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract as extractTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { packOpenClawPackageForDocker } from "../../scripts/package-openclaw-for-docker.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selected = ["brave", "codex", "diagnostics-otel", "matrix", "tokenjuice"];
const patchedBytes = "module.exports = 'patched:' + require('closure-child');\n";
const skipUnrelatedLifecycle = {
  prepareDocsMap: async () => {},
  restoreDocsMap: async () => {},
  prepareManifest: async () => {},
  restoreManifest: async () => {},
  prepareWorkerBundle: async () => {},
  restoreWorkerBundle: async () => {},
  prepareChangelog: async () => {},
  restoreChangelog: async () => {},
  prepareBundledAiRuntime: async () => async () => {},
  runImpl: async () => {},
};

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function fixture(isolated = false) {
  const root = tempDirs.make("packaging-promoted-patches-source-");
  const output = tempDirs.make("packaging-promoted-patches-output-");
  const json = (relative: string, value: unknown) => write(path.join(root, relative), value);
  json("package.json", {
    name: "openclaw",
    version: "2026.11.3",
    files: ["dist", ...[...selected, "unselected"].map((id) => `!dist/extensions/${id}/**`)],
    dependencies: { existing: "1.0.0", "closure-child": "9.0.0" },
    bundleDependencies: ["existing", "closure-child"],
  });
  json("node_modules/existing/package.json", { name: "existing", version: "1.0.0" });
  json("node_modules/existing/index.js", "module.exports = 'existing';\n");
  json("node_modules/closure-child/package.json", {
    name: "closure-child",
    version: "9.0.0",
    main: "index.js",
  });
  json("node_modules/closure-child/index.js", "module.exports = 'wrong root version';\n");
  fs.symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(root, "node_modules/tsx"),
    "junction",
  );
  const patches: Record<string, string> = { "unselected-dep@1.0.0": "missing-unselected.patch" };
  const hashes: Record<string, string> = {};
  const importers: Record<string, unknown> = { ".": {} };
  const locations: Record<string, string[]> = {};
  const installed: Record<string, string> = {};
  for (const id of [...selected, "unselected"]) {
    const dependency = id === "matrix" ? "matrix-js-sdk" : "@fixture/another-patch";
    const version = id === "matrix" ? "42.4.0" : "1.0.0";
    const field = id === "matrix" ? "dependencies" : "optionalDependencies";
    const ownsPatch = id === "matrix" || id === "codex";
    const manifest = {
      name: `@openclaw/${id}`,
      version: "2026.11.3",
      ...(ownsPatch ? { [field]: { [dependency]: version } } : {}),
      ...(id === "unselected" ? { dependencies: { "unselected-dep": "1.0.0" } } : {}),
      openclaw: { extensions: ["./index.ts"], build: { bundledDist: false } },
    };
    json(`extensions/${id}/package.json`, manifest);
    json(`extensions/${id}/openclaw.plugin.json`, { id });
    json(`extensions/${id}/index.ts`, "export {};\n");
    json(`dist/extensions/${id}/package.json`, {
      ...manifest,
      openclaw: { ...manifest.openclaw, extensions: ["./index.js"] },
    });
    json(`dist/extensions/${id}/openclaw.plugin.json`, { id });
    json(`dist/extensions/${id}/index.js`, "module.exports = {};\n");
    if (!ownsPatch) {
      continue;
    }
    const selector = `${dependency}@${version}`;
    const patch = `synthetic patch for ${selector}\n`;
    const hash = createHash("sha256").update(patch).digest("hex");
    patches[selector] = `patches/${id}.patch`;
    hashes[selector] = hash;
    json(patches[selector], patch);
    const identity = `${version}(patch_hash=${hash})`;
    importers[`extensions/${id}`] = {
      [field]: { [dependency]: { specifier: version, version: identity } },
    };
    // The owning importer resolves through its private install, not a root lookalike.
    const nodeModules = isolated
      ? `node_modules/.pnpm/${dependency.replace("/", "+")}@${version}_patch_hash=${hash}/node_modules`
      : `extensions/${id}/node_modules`;
    const relative = `${nodeModules}/${dependency}`;
    const source = path.join(root, relative);
    installed[dependency] = source;
    locations[`${dependency}@${identity}`] = [relative];
    json(`${relative}/package.json`, {
      name: dependency,
      version,
      main: "index.js",
      dependencies: { "closure-child": "1.0.0" },
      optionalDependencies: { "absent-optional": "1.0.0" },
      devDependencies: { "absent-dev": "1.0.0" },
    });
    json(`${relative}/index.js`, patchedBytes);
    if (isolated) {
      const link = path.join(root, "extensions", id, "node_modules", dependency);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), source), link, "junction");
    }
    const child = `${nodeModules}/closure-child`;
    json(`${child}/package.json`, {
      name: "closure-child",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "closure-leaf": "1.0.0" },
    });
    json(`${child}/index.js`, "module.exports = require('closure-leaf');\n");
    json(`${nodeModules}/closure-leaf/package.json`, {
      name: "closure-leaf",
      version: "1.0.0",
      main: "index.js",
      dependencies: { events: "3.3.0" },
    });
    json(`${nodeModules}/closure-leaf/index.js`, "module.exports = 'frozen leaf';\n");
    json(`${nodeModules}/events/package.json`, { name: "events", version: "3.3.0" });
    json(`${nodeModules}/events/index.js`, "module.exports = 'frozen browser events';\n");
  }
  // Preserve an existing root link even though it is not the owning importer's patched bytes.
  json("unpatched/package.json", { name: "matrix-js-sdk", version: "42.4.0" });
  json("unpatched/index.js", "module.exports = 'registry bytes';\n");
  fs.symlinkSync("../unpatched", path.join(root, "node_modules/matrix-js-sdk"), "junction");
  json("pnpm-workspace.yaml", { patchedDependencies: patches });
  const lock = { importers, patchedDependencies: hashes };
  json("pnpm-lock.yaml", lock);
  json("node_modules/.pnpm/lock.yaml", lock);
  json(
    "node_modules/.modules.yaml",
    isolated
      ? { nodeLinker: "isolated", virtualStoreDirMaxLength: 250 }
      : { nodeLinker: "hoisted", hoistedLocations: locations },
  );
  const originals = new Map(
    ["package.json", ...selected.map((id) => `dist/extensions/${id}/package.json`)].map(
      (relative) => [relative, fs.readFileSync(path.join(root, relative), "utf8")],
    ),
  );
  const installedPackage = (name: string) => {
    const source = installed[name];
    if (!source) {
      throw new Error(`Missing installed fixture package: ${name}`);
    }
    return source;
  };
  const restored = () => {
    for (const [relative, bytes] of originals) {
      expect(fs.readFileSync(path.join(root, relative), "utf8")).toBe(bytes);
    }
    expect(fs.readlinkSync(path.join(root, "node_modules/matrix-js-sdk"))).toBe("../unpatched");
    expect(fs.existsSync(path.join(root, "node_modules/@fixture/another-patch"))).toBe(false);
    expect(
      fs
        .readdirSync(path.join(root, "node_modules"))
        .filter((name) => name.startsWith(".openclaw-")),
    ).toEqual([]);
    expect(fs.readFileSync(path.join(installedPackage("matrix-js-sdk"), "index.js"), "utf8")).toBe(
      patchedBytes,
    );
    expect(fs.existsSync(path.join(root, "dist/postinstall-inventory.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".openclaw-lifecycle-pending"))).toBe(false);
  };
  const pack = (options: Parameters<typeof packOpenClawPackageForDocker>[2] = {}) =>
    packOpenClawPackageForDocker(root, output, {
      ...skipUnrelatedLifecycle,
      bundlePlugins: selected,
      ...options,
    });
  return { root, output, installedPackage, json, lock, restored, pack };
}

describe("selected plugin patched runtime packaging", () => {
  it.each([
    { pnpmPack: false, isolated: false },
    { pnpmPack: true, isolated: false },
    { pnpmPack: false, isolated: true },
    { pnpmPack: true, isolated: true },
  ])(
    "archives frozen patched bytes and their closure (pnpm=$pnpmPack, isolated=$isolated)",
    async ({ pnpmPack, isolated }) => {
      const input = fixture(isolated);
      const archive = await input.pack({ pnpmPack });
      const extracted = tempDirs.make("packaging-promoted-patches-extracted-");
      await extractTar({ file: archive, cwd: extracted });
      const packed = path.join(extracted, "package");
      const manifest = JSON.parse(fs.readFileSync(path.join(packed, "package.json"), "utf8"));
      expect(manifest.bundleDependencies).toEqual([
        "existing",
        "closure-child",
        "@fixture/another-patch",
        "matrix-js-sdk",
      ]);
      for (const dependency of ["matrix-js-sdk", "@fixture/another-patch"]) {
        expect(
          fs.readFileSync(path.join(packed, "node_modules", dependency, "index.js"), "utf8"),
        ).toBe(patchedBytes);
        expect(
          fs.readFileSync(path.join(packed, "node_modules", dependency, "package.json"), "utf8"),
        ).toBe(
          fs.readFileSync(path.join(input.installedPackage(dependency), "package.json"), "utf8"),
        );
        expect(createRequire(path.join(packed, "package.json"))(dependency)).toBe(
          "patched:frozen leaf",
        );
        expect(
          fs.readFileSync(
            path.join(
              packed,
              "node_modules",
              dependency,
              "node_modules/closure-child/node_modules/closure-leaf/node_modules/events/index.js",
            ),
            "utf8",
          ),
        ).toBe("module.exports = 'frozen browser events';\n");
      }
      expect(createRequire(path.join(packed, "package.json"))("closure-child")).toBe(
        "wrong root version",
      );
      expect(fs.existsSync(path.join(packed, "dist/extensions/unselected"))).toBe(false);
      expect(fs.existsSync(path.join(packed, "node_modules/unselected-dep"))).toBe(false);
      input.restored();
    },
  );

  it.each(["importer", "patch", "location", "identity"])(
    "rejects mismatched frozen %s before packing",
    async (mismatch) => {
      const input = fixture();
      if (mismatch === "importer") {
        input.json("node_modules/.pnpm/lock.yaml", { ...input.lock, importers: { ".": {} } });
      } else if (mismatch === "patch") {
        input.json("patches/matrix.patch", "changed patch\n");
      } else if (mismatch === "location") {
        input.json("node_modules/.modules.yaml", { nodeLinker: "hoisted", hoistedLocations: {} });
      } else {
        write(path.join(input.installedPackage("matrix-js-sdk"), "package.json"), {
          name: "matrix-js-sdk",
          version: "0.0.0",
        });
      }
      await expect(
        input.pack({
          runCaptureImpl: async () => {
            throw new Error("unexpected root pack");
          },
        }),
      ).rejects.toThrow(
        mismatch === "location"
          ? "not the frozen pnpm package"
          : mismatch === "identity"
            ? "identity mismatch"
            : "matching frozen pnpm install",
      );
      input.restored();
    },
  );

  it("restores original links and manifests after root pack failure", async () => {
    const input = fixture();
    await expect(
      input.pack({
        runCaptureImpl: async () => {
          expect(
            fs.lstatSync(path.join(input.root, "node_modules/matrix-js-sdk")).isSymbolicLink(),
          ).toBe(false);
          throw new Error("synthetic root pack failure");
        },
      }),
    ).rejects.toThrow("synthetic root pack failure");
    input.restored();
  });

  it("restores earlier stages when a required runtime closure is missing", async () => {
    const input = fixture();
    fs.rmSync(path.join(input.root, "extensions/matrix/node_modules/closure-leaf"), {
      recursive: true,
    });
    await expect(input.pack()).rejects.toThrow("closure-leaf");
    input.restored();
  });
});
