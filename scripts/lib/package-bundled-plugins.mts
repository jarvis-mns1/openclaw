// Composes explicitly selected source plugins into a custom core distribution.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  composePackagePlugins,
  type DistributionPackageManifest,
} from "../../src/infra/package-plugin-composition.ts";
import type { PackageManifest } from "../../src/plugins/package-manifest.types.ts";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "../../src/shared/non-packaged-plugin-dirs.ts";
import {
  collectBundledPluginBuildEntries,
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "./bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./output-root-guard.mjs";
import {
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "./package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";
import {
  collectWorkspacePatchedDependencies,
  listPackageRuntimeDependencyNames,
  type WorkspacePatchedDependency,
} from "./package-patched-dependencies.mts";

type PackageJson = DistributionPackageManifest &
  Pick<PackageManifest, "openclaw"> & {
    bundleDependencies?: string[];
    bundledDependencies?: string[];
  };

async function copyInstalledRuntimeClosure(
  source: string,
  destination: string,
  ancestors: ReadonlyMap<string, string>,
) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  ) as PackageJson;
  // pnpm's runtime edges live beside the package in its virtual store. Copy
  // only those resolved edges, nested so root versions cannot shadow them.
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => entry !== path.join(source, "node_modules"),
  });
  const require = createRequire(path.join(source, "package.json"));
  const names = new Set([
    ...listPackageRuntimeDependencyNames(manifest),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const name of names) {
    const candidate = require.resolve
      .paths(name)
      ?.map((dir) => path.join(dir, name))
      .find((dir) => existsSync(path.join(dir, "package.json")));
    if (!candidate) {
      if (
        Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(manifest.dependencies ?? {}, name) &&
          manifest.peerDependenciesMeta?.[name]?.optional)
      ) {
        continue;
      }
      throw new Error(`Missing installed runtime dependency ${name} required by ${manifest.name}`);
    }
    const resolved = await fs.realpath(candidate);
    // A cycle can resolve through the already materialized ancestor.
    if (ancestors.get(name) === resolved) {
      continue;
    }
    await copyInstalledRuntimeClosure(
      resolved,
      path.join(destination, "node_modules", name),
      new Map([...ancestors, [name, resolved]]),
    );
  }
}

export function resolvePackageBundledPlugins(sourceDir: string, pluginIds: string[]) {
  const ids = [...new Set(pluginIds)].toSorted();
  if (ids.length === 0) {
    return [];
  }
  const entries = collectBundledPluginBuildEntries({
    cwd: sourceDir,
    env: { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: ids.join(",") },
  });
  const excluded = collectRootPackageExcludedExtensionDirs({ cwd: sourceDir });
  return ids.map((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry?.hasPackageJson || !excluded.has(id) || NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id)) {
      throw new Error(
        `--bundle-plugin requires a source plugin excluded from the core package: ${id}`,
      );
    }
    return entry;
  });
}

/** Called under the canonical packer's source lifecycle lock, before bundling workspace deps. */
export async function preparePackageBundledPlugins(
  sourceDir: string,
  pluginIds: string[],
  onCleanupFailure: (error: Error) => void,
) {
  const selected = resolvePackageBundledPlugins(sourceDir, pluginIds);
  if (selected.length === 0) {
    return async () => {};
  }
  assertRealOutputRoot(path.join(sourceDir, "dist"));
  const packagePath = path.join(sourceDir, "package.json");
  const original = await fs.readFile(packagePath, "utf8");
  const sourcePackageJson = JSON.parse(original) as PackageJson;
  const pluginPackages = new Map<string, PackageJson>();
  const patchedDependencies = new Map<string, WorkspacePatchedDependency>();
  for (const { id, sourceEntries } of selected) {
    const sourcePluginDir = path.join(sourceDir, "extensions", id);
    const sourcePackage = JSON.parse(
      await fs.readFile(path.join(sourcePluginDir, "package.json"), "utf8"),
    ) as PackageJson;
    const pluginRoot = path.join(sourceDir, "dist", "extensions", id);
    const builtPackage = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"),
    ) as PackageJson;
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { id: string };
    if (
      manifest.id !== id ||
      (
        [
          "name",
          "version",
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
        ] as const
      ).some((key) => !isDeepStrictEqual(builtPackage[key], sourcePackage[key]))
    ) {
      throw new Error(
        `Built plugin ${id} does not match source metadata; rebuild before packaging`,
      );
    }
    const extension = path.extname(builtPackage.openclaw?.extensions?.[0] ?? "index.js");
    for (const entry of sourceEntries) {
      await fs.access(path.join(pluginRoot, entry.replace(/\.[^.]+$/u, extension)));
    }
    pluginPackages.set(`dist/extensions/${id}/package.json`, builtPackage);
    // Validate every selected owner before deduplicating; a root declaration
    // or another plugin's frozen importer does not establish this one's bytes.
    for (const dependency of collectWorkspacePatchedDependencies(
      sourceDir,
      sourcePluginDir,
      sourcePackage,
    )) {
      const previous = patchedDependencies.get(dependency.name);
      if (previous && previous.packageDir !== dependency.packageDir) {
        throw new Error(
          `Selected plugins resolve different patched runtime packages: ${dependency.name}`,
        );
      }
      patchedDependencies.set(dependency.name, dependency);
    }
  }
  const packageJson = composePackagePlugins(
    sourcePackageJson,
    selected.map(({ id, packageJson: pluginPackage }) => ({
      id,
      packageJson: pluginPackage as PackageJson,
    })),
  );
  if (patchedDependencies.size) {
    const bundles = packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [];
    if (!Array.isArray(bundles)) {
      throw new Error("root package.json bundleDependencies must be an array when present");
    }
    packageJson.bundleDependencies = [...new Set([...bundles, ...patchedDependencies.keys()])];
    delete packageJson.bundledDependencies;
  }
  const snapshots = await Promise.all(
    [
      "package.json",
      PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
      PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
      ...pluginPackages.keys(),
    ].map(async (relativePath) => {
      const target = path.join(sourceDir, relativePath);
      const bytes = await fs.readFile(target).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
        return null;
      });
      return { target, bytes };
    }),
  );
  const stagedDependencies: Array<{
    target: string;
    stage: string;
    originalMoved: boolean;
    stagedInstalled: boolean;
  }> = [];
  const createdScopes = new Set<string>();
  const cleanup = async (preparationFailure?: { cause: unknown }) => {
    const results = await Promise.allSettled([
      ...snapshots.map(({ target, bytes }) =>
        bytes === null ? fs.rm(target, { force: true }) : fs.writeFile(target, bytes),
      ),
      ...stagedDependencies.map(async (entry) => {
        if (entry.stagedInstalled) {
          await fs.rm(entry.target, { recursive: true, force: true });
          entry.stagedInstalled = false;
        }
        if (entry.originalMoved) {
          await fs.rename(path.join(entry.stage, "original"), entry.target);
          entry.originalMoved = false;
        }
        // Keep the backup for recovery if restoration failed.
        await fs.rm(entry.stage, { recursive: true, force: true });
      }),
    ]);
    results.push(...(await Promise.allSettled([...createdScopes].map((scope) => fs.rmdir(scope)))));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      const error = new AggregateError(
        [
          ...(preparationFailure ? [preparationFailure.cause] : []),
          ...failures.map((result) => result.reason),
        ],
        "Selected plugin package cleanup failed",
        preparationFailure,
      );
      onCleanupFailure(error);
      throw error;
    }
  };
  try {
    for (const { name, packageDir } of patchedDependencies.values()) {
      const nodeModules = path.join(sourceDir, "node_modules");
      assertRealOutputRoot(nodeModules);
      const target = path.join(nodeModules, name);
      const parent = path.dirname(target);
      if (parent !== nodeModules) {
        assertRealOutputRoot(parent);
        const created = await fs.mkdir(parent, { recursive: true });
        if (created) {
          createdScopes.add(parent);
        }
      }
      const stage = await fs.mkdtemp(path.join(nodeModules, ".openclaw-plugin-patch-"));
      const entry = { target, stage, originalMoved: false, stagedInstalled: false };
      stagedDependencies.push(entry);
      const prepared = path.join(stage, "prepared");
      await copyInstalledRuntimeClosure(packageDir, prepared, new Map([[name, packageDir]]));
    }
    // Resolve every closure before any root link changes another owner's lookup.
    for (const entry of stagedDependencies) {
      try {
        await fs.rename(entry.target, path.join(entry.stage, "original"));
        entry.originalMoved = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      await fs.rename(path.join(entry.stage, "prepared"), entry.target);
      entry.stagedInstalled = true;
    }
    await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    // Explicit composition transfers ownership to this distribution. Without
    // this fact, Doctor retains an older managed npm copy with the same version.
    for (const [relativePath, pluginPackage] of pluginPackages) {
      pluginPackage.openclaw = {
        ...pluginPackage.openclaw,
        build: { ...pluginPackage.openclaw?.build, bundledDist: true },
      };
      await fs.writeFile(
        path.join(sourceDir, relativePath),
        `${JSON.stringify(pluginPackage, null, 2)}\n`,
      );
    }
    // Inventory must see the custom manifest before pack, or postinstall would prune the plugin.
    const { writePackageDistInventoryForPublish } = await import("./package-dist-inventory.ts");
    await writePackageDistInventoryForPublish(sourceDir);
    return cleanup;
  } catch (error) {
    await cleanup({ cause: error });
    throw error;
  }
}
