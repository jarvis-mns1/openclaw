import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract as extractTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  packOpenClawPackageForDocker,
  prepareBundledNpmRuntimePackage,
} from "../../scripts/package-openclaw-for-docker.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(materialized: boolean) {
  const root = tempDirs.make("openclaw-npm-bundle-pack-");
  const output = tempDirs.make("openclaw-npm-bundle-output-");
  const storePackage = path.join(root, "node_modules/.pnpm/npm@12.2.2/node_modules/npm");
  const installedPackage = path.join(root, "node_modules/npm");
  const packageRoot = materialized ? installedPackage : storePackage;
  const json = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  json(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.11.3",
    dependencies: { npm: "12.2.2" },
    bundleDependencies: ["npm"],
    files: ["index.js"],
  });
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 'root';\n");
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "nodeLinker: isolated\n");
  json(path.join(packageRoot, "package.json"), {
    name: "npm",
    version: "12.2.2",
    main: "index.js",
    files: ["index.js"],
    dependencies: { glob: "14.0.2" },
    bundleDependencies: ["glob"],
  });
  fs.writeFileSync(path.join(packageRoot, "index.js"), "module.exports = require('glob');\n");
  json(path.join(packageRoot, "node_modules/glob/package.json"), {
    name: "glob",
    version: "14.0.2",
    main: "index.js",
    dependencies: { "private-child": "1.0.0" },
  });
  fs.writeFileSync(
    path.join(packageRoot, "node_modules/glob/index.js"),
    "module.exports = require('private-child');\n",
  );
  json(path.join(packageRoot, "node_modules/private-child/package.json"), {
    name: "private-child",
    version: "1.0.0",
    main: "index.js",
  });
  fs.writeFileSync(
    path.join(packageRoot, "node_modules/private-child/index.js"),
    "module.exports = 'corrected bundled bytes';\n",
  );
  if (!materialized) {
    fs.symlinkSync(
      path.relative(path.dirname(installedPackage), storePackage),
      installedPackage,
      "junction",
    );
  }
  fs.symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(root, "node_modules/tsx"),
    "junction",
  );
  return { root, output, installedPackage, storePackage };
}

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

describe("root packing of a self-contained npm bundle", () => {
  it.each([
    { pnpmPack: false, materialized: false },
    { pnpmPack: true, materialized: false },
    { pnpmPack: false, materialized: true },
    { pnpmPack: true, materialized: true },
  ])(
    "preserves nested bytes (pnpm=$pnpmPack, materialized=$materialized)",
    async ({ pnpmPack, materialized }) => {
      const input = fixture(materialized);
      const originalManifest = fs.readFileSync(path.join(input.root, "package.json"), "utf8");
      const originalLink = materialized ? undefined : fs.readlinkSync(input.installedPackage);
      const archive = await packOpenClawPackageForDocker(input.root, input.output, {
        pnpmPack,
        ...skipUnrelatedLifecycle,
      });
      const extracted = tempDirs.make("openclaw-npm-bundle-extracted-");
      await extractTar({ file: archive, cwd: extracted });
      const packed = path.join(extracted, "package");
      expect(fs.existsSync(path.join(packed, "node_modules/.pnpm"))).toBe(false);
      expect(
        fs.readFileSync(path.join(packed, "node_modules/npm/node_modules/glob/index.js"), "utf8"),
      ).toBe("module.exports = require('private-child');\n");
      expect(
        fs.readFileSync(
          path.join(packed, "node_modules/npm/node_modules/private-child/index.js"),
          "utf8",
        ),
      ).toBe("module.exports = 'corrected bundled bytes';\n");
      expect(createRequire(path.join(packed, "package.json"))("npm")).toBe(
        "corrected bundled bytes",
      );
      expect(
        fs
          .readdirSync(path.join(packed, "node_modules"))
          .some((name) => name.startsWith(".openclaw-npm-package-")),
      ).toBe(false);
      expect(fs.readFileSync(path.join(input.root, "package.json"), "utf8")).toBe(originalManifest);
      if (originalLink !== undefined) {
        expect(fs.readlinkSync(input.installedPackage)).toBe(originalLink);
      }
      expect(
        fs
          .readdirSync(path.join(input.root, "node_modules"))
          .some((name) => name.startsWith(".openclaw-npm-package-")),
      ).toBe(false);
    },
  );

  it("restores the original link when the root pack fails", async () => {
    const input = fixture(false);
    const originalLink = fs.readlinkSync(input.installedPackage);
    await expect(
      packOpenClawPackageForDocker(input.root, input.output, {
        ...skipUnrelatedLifecycle,
        runCaptureImpl: async () => {
          expect(fs.lstatSync(input.installedPackage).isSymbolicLink()).toBe(false);
          throw new Error("synthetic root pack failure");
        },
      }),
    ).rejects.toThrow("synthetic root pack failure");
    expect(fs.readlinkSync(input.installedPackage)).toBe(originalLink);
    expect(
      fs
        .readdirSync(path.join(input.root, "node_modules"))
        .some((name) => name.startsWith(".openclaw-npm-package-")),
    ).toBe(false);
  });

  it("leaves the original link intact when materialization fails", async () => {
    const input = fixture(false);
    const originalLink = fs.readlinkSync(input.installedPackage);
    fs.symlinkSync("missing-runtime", path.join(input.storePackage, "broken-link"));
    await expect(prepareBundledNpmRuntimePackage(input.root)).rejects.toThrow();
    expect(fs.readlinkSync(input.installedPackage)).toBe(originalLink);
    expect(
      fs
        .readdirSync(path.join(input.root, "node_modules"))
        .some((name) => name.startsWith(".openclaw-npm-package-")),
    ).toBe(false);
  });
});
