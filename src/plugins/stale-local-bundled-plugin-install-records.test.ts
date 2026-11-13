import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  pruneStaleLocalBundledPluginInstallRecords,
} from "./stale-local-bundled-plugin-install-records.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function bundledSource(pluginId: string, localPath: string): Map<string, BundledPluginSource> {
  return new Map([
    [
      pluginId,
      {
        pluginId,
        localPath,
        version: "2026.5.20",
      },
    ],
  ]);
}

describe("listStaleLocalBundledPluginInstallRecords", () => {
  it("does not list the current bundled path", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: currentPath,
            version: "2026.5.4-beta.3",
          },
        },
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual([]);
  });

  it("does not infer foreign ownership from compiled-looking paths without a stale version", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "discord"),
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "acpx"),
            version: "2026.5.20",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });

  it("does not list source checkout or arbitrary local plugin paths", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/openclaw", "extensions", "discord"),
            version: "2026.5.4-beta.3",
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/custom-plugins", "acpx"),
            version: "2026.5.4-beta.3",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });

  it.each([
    { mode: "same-version", stale: true },
    { mode: "missing-version", stale: true },
    { mode: "dist-runtime", stale: true },
    { mode: "foreign-symlink", stale: true },
    { mode: "current", stale: false },
    { mode: "current-symlink", stale: false },
    { mode: "config-directory", stale: false },
    { mode: "config-entry", stale: false },
    { mode: "config-parent", stale: false },
    { mode: "config-old-version", stale: false },
    { mode: "dev-root", stale: false },
    { mode: "dev-old-version", stale: false },
    { mode: "source-link", stale: false },
    { mode: "external", stale: false },
    { mode: "lookalike", stale: false },
    { mode: "missing-path", stale: false },
    { mode: "manifest-id", stale: false },
    { mode: "missing-current", stale: false },
  ])("respects $mode bundle ownership during cleanup", ({ mode, stale }) => {
    const root = tempDirs.make("openclaw-bundled-record-relocation-");
    const currentRoot = path.join(root, "runtime-b");
    const previousRoot = path.join(root, "runtime-a");
    const relativeRoot =
      mode === "source-link"
        ? "extensions"
        : mode === "external"
          ? "plugins"
          : mode === "dist-runtime"
            ? "dist-runtime/extensions"
            : "dist/extensions";
    const previousPath = path.join(previousRoot, relativeRoot, "probe");
    const currentPath = path.join(currentRoot, "dist", "extensions", "probe");
    for (const [packageRoot, pluginRoot] of [
      [previousRoot, previousPath],
      [currentRoot, currentPath],
    ] as const) {
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: mode === "lookalike" && packageRoot === previousRoot ? "custom" : "openclaw",
          version: "2026.11.3",
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "@openclaw/probe",
          version: "2026.11.3",
          openclaw: { extensions: ["./index.ts"] },
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: mode === "manifest-id" && packageRoot === previousRoot ? "different" : "probe",
          configSchema: { type: "object" },
        }),
      );
      fs.writeFileSync(path.join(pluginRoot, "index.ts"), "throw new Error('metadata only');\n");
    }
    let installPath = mode.startsWith("current") ? currentPath : previousPath;
    if (mode.endsWith("symlink")) {
      const alias = path.join(root, "alias");
      fs.symlinkSync(installPath, alias, "dir");
      installPath = alias;
    }
    if (mode === "missing-path") {
      fs.rmSync(previousPath, { recursive: true });
    }
    if (mode === "missing-current") {
      fs.rmSync(currentPath, { recursive: true });
    }
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_VERSION: "2026.11.3",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(currentPath),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    if (mode.startsWith("dev-")) {
      fs.mkdirSync(path.join(previousRoot, "src"));
      fs.mkdirSync(path.join(previousRoot, "extensions"));
      env.OPENCLAW_DEV_SOURCE_ROOT = previousRoot;
    }
    const config: OpenClawConfig = mode.startsWith("config-")
      ? {
          plugins: {
            load: {
              paths: [
                mode === "config-entry"
                  ? path.join(previousPath, "index.ts")
                  : mode === "config-parent"
                    ? path.dirname(previousPath)
                    : previousPath,
              ],
            },
          },
        }
      : {};
    const records: Record<string, PluginInstallRecord> = {
      probe: {
        source: "path",
        installPath,
        ...(mode === "missing-version"
          ? {}
          : { version: mode.endsWith("old-version") ? "2026.11.2" : "2026.11.3" }),
      },
    };
    const result = withPluginCache(createPluginCache(), () =>
      pruneStaleLocalBundledPluginInstallRecords({
        config,
        installRecords: records,
        env,
        bundled: new Map([
          ["probe", { pluginId: "probe", localPath: currentPath, version: "2026.11.3" }],
        ]),
      }),
    );
    expect(result.stale.map((record) => record.pluginId)).toEqual(stale ? ["probe"] : []);
    expect(result.records).toEqual(stale ? {} : records);
  });
});

describe("pruneStaleLocalBundledPluginInstallRecords", () => {
  it("removes only stale local bundled plugin install records", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");
    const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        installPath: stalePath,
        version: "2026.5.4-beta.3",
      },
      brave: {
        source: "npm",
        installPath: "/tmp/plugins/brave",
      },
    };

    expect(
      pruneStaleLocalBundledPluginInstallRecords({
        installRecords: records,
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual({
      records: {
        brave: records.brave,
      },
      stale: [
        {
          pluginId: "discord",
          record: records.discord,
          recordPathField: "installPath",
          stalePath,
          bundledPath: currentPath,
        },
      ],
    });
  });
});
