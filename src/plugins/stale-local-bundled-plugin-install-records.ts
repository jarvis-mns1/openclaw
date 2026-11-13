// Detects stale local bundled plugin install records.
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { isForeignBundledPluginRoot } from "./bundled-dir.js";
import { normalizeBundledLookupPath } from "./bundled-load-path-aliases.js";
import { resolveBundledPluginSources, type BundledPluginSource } from "./bundled-sources.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { pluginCacheRealpathSync } from "./plugin-cache-files.js";

/** Stale install record that points at old compiled bundled plugin output. */
export type StaleLocalBundledPluginInstallRecord = {
  pluginId: string;
  record: PluginInstallRecord;
  recordPathField: "installPath" | "sourcePath";
  stalePath: string;
  bundledPath: string;
};

function normalizePathForCompare(rawPath: string, env?: NodeJS.ProcessEnv): string {
  return path.resolve(normalizeBundledLookupPath(resolveUserPath(rawPath, env)));
}

function primaryInstallRecordPath(record: PluginInstallRecord): {
  field: "installPath" | "sourcePath";
  path: string;
} | null {
  if (typeof record.installPath === "string" && record.installPath.trim()) {
    return { field: "installPath", path: record.installPath };
  }
  if (typeof record.sourcePath === "string" && record.sourcePath.trim()) {
    return { field: "sourcePath", path: record.sourcePath };
  }
  return null;
}

function looksLikeCompiledBundledPluginPath(targetPath: string, pluginId: string): boolean {
  const segments = normalizeBundledLookupPath(targetPath).split(/[\\/]+/u);
  return segments.some((segment, index) => {
    return (
      (segment === "dist" || segment === "dist-runtime") &&
      segments[index + 1] === "extensions" &&
      segments[index + 2] === pluginId
    );
  });
}

function hasStaleBundledVersion(
  record: PluginInstallRecord,
  bundledSource: BundledPluginSource,
): boolean {
  const recordVersion = record.version?.trim();
  const bundledVersion = bundledSource.version?.trim();
  return Boolean(recordVersion && bundledVersion && recordVersion !== bundledVersion);
}

/** Lists path install records that still point at stale compiled bundled plugin output. */
export function listStaleLocalBundledPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundled?: ReadonlyMap<string, BundledPluginSource>;
}): StaleLocalBundledPluginInstallRecord[] {
  const env = params.env ?? process.env;
  const bundled =
    params.bundled ??
    resolveBundledPluginSources({
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const stale: StaleLocalBundledPluginInstallRecord[] = [];
  let selectedBundledPaths: Map<string, string> | undefined;
  const isCurrentBundleSelected = (pluginId: string, bundledPath: string): boolean => {
    // Reuse the loader's explicit-path precedence without loading plugin runtime.
    selectedBundledPaths ??= new Map(
      loadPluginManifestRegistryCore({
        config: params.config,
        installRecords: params.installRecords,
        workspaceDir: params.workspaceDir,
        env,
      }).plugins.flatMap((plugin) =>
        plugin.origin === "bundled"
          ? [[plugin.id, pluginCacheRealpathSync(plugin.rootDir) ?? plugin.rootDir] as const]
          : [],
      ),
    );
    return selectedBundledPaths.get(pluginId) === bundledPath;
  };

  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (record.source !== "path") {
      continue;
    }
    const bundledSource = bundled.get(pluginId);
    if (!bundledSource?.localPath) {
      continue;
    }
    const recordPath = primaryInstallRecordPath(record);
    if (!recordPath) {
      continue;
    }
    const stalePath = normalizePathForCompare(recordPath.path, params.env);
    const bundledPath = normalizePathForCompare(bundledSource.localPath, params.env);
    const physicalStalePath = pluginCacheRealpathSync(stalePath) ?? stalePath;
    const physicalBundledPath = pluginCacheRealpathSync(bundledPath) ?? bundledPath;
    if (
      physicalStalePath === physicalBundledPath ||
      isBundledPluginInsideDevSourceRoot({ rootDir: stalePath, env })
    ) {
      continue;
    }
    const staleVersion =
      hasStaleBundledVersion(record, bundledSource) &&
      looksLikeCompiledBundledPluginPath(physicalStalePath, pluginId);
    if (!staleVersion) {
      // Immutable installations can move without changing their release version.
      if (!isForeignBundledPluginRoot(stalePath, env)) {
        continue;
      }
      const manifest = loadPluginManifest(stalePath, false);
      if (!manifest.ok || manifest.manifest.id !== pluginId) {
        continue;
      }
    }
    if (
      (!staleVersion || params.config?.plugins?.load?.paths?.length) &&
      !isCurrentBundleSelected(pluginId, physicalBundledPath)
    ) {
      continue;
    }
    stale.push({
      pluginId,
      record,
      recordPathField: recordPath.field,
      stalePath,
      bundledPath,
    });
  }

  return stale;
}

/** Removes stale compiled bundled plugin path records from an install record map. */
export function pruneStaleLocalBundledPluginInstallRecords(
  params: Parameters<typeof listStaleLocalBundledPluginInstallRecords>[0],
): {
  records: Record<string, PluginInstallRecord>;
  stale: StaleLocalBundledPluginInstallRecord[];
} {
  const stale = listStaleLocalBundledPluginInstallRecords(params);
  if (stale.length === 0) {
    return { records: params.installRecords, stale };
  }
  const staleIds = new Set(stale.map((record) => record.pluginId));
  return {
    records: Object.fromEntries(
      Object.entries(params.installRecords).filter(([pluginId]) => !staleIds.has(pluginId)),
    ),
    stale,
  };
}
