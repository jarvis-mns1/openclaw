import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  packageRuntimeDependencyField,
  parsePnpmPackageKey,
  type NpmLocalPackageArtifact,
} from "../generate-npm-package-lock.mts";
import { resolveNpmRunner } from "../npm-runner.mts";
import { pnpmLockfileDocuments } from "./pnpm-lockfile-documents.mjs";
import { isRecord } from "./record-shared.mjs";

type PackageRuntimeDependencies = {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

export function listPackageRuntimeDependencyNames(packageJson: PackageRuntimeDependencies) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function spawnNpmSync(args: string[], options: SpawnSyncOptions = {}) {
  const invocation = resolveNpmRunner({ npmArgs: args, env: options.env ?? process.env });
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    ...(invocation.env ? { env: invocation.env } : {}),
    shell: invocation.shell,
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

export type WorkspacePatchedDependency = { name: string; version: string; packageDir: string };

function readYamlRecord(file: string, lockfile = false) {
  const source = fs.readFileSync(file, "utf8");
  const value: unknown = parseYaml(lockfile ? pnpmLockfileDocuments(source).dependencies : source);
  return isRecord(value) ? value : {};
}

function isolatedPnpmPackageDirectory(
  storeDir: string,
  dependencyPath: string,
  name: string,
  maxLength: unknown,
) {
  if (typeof maxLength !== "number" || !Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error("frozen pnpm install has an invalid virtualStoreDirMaxLength");
  }
  // pnpm 12's PkgNameVerPeer::to_virtual_store_name and shorten_virtual_store_name.
  let filename = dependencyPath.replace(/[\\/:*?"<>|#]/gu, "+");
  if (filename.includes("(")) {
    filename = filename.replace(/\)$/u, "").replaceAll(")(", "_").replace(/[()]/gu, "_");
  }
  if (Buffer.byteLength(filename) > maxLength || /[A-Z]/u.test(filename)) {
    let prefix = "";
    for (const character of filename) {
      if (Buffer.byteLength(prefix + character) > Math.max(0, maxLength - 33)) {
        break;
      }
      prefix += character;
    }
    filename = `${prefix}_${createHash("sha256").update(filename).digest("hex").slice(0, 32)}`;
  }
  return path.join(fs.realpathSync(storeDir), filename, "node_modules", name);
}

export function collectWorkspacePatchedDependencies(
  repoRoot: string,
  packageDir: string,
  packageJson: PackageRuntimeDependencies,
) {
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const declared = readYamlRecord(workspacePath).patchedDependencies;
  if (!isRecord(declared)) {
    return [];
  }
  const names = new Set(listPackageRuntimeDependencyNames(packageJson));
  // check-package-patches owns the allowlist and permits only exact-version selectors.
  let selected = Object.entries(declared).flatMap(([selector, patchPath]) => {
    const parsed = parsePnpmPackageKey(selector);
    return parsed && names.has(parsed.name) ? [{ ...parsed, selector, patchPath }] : [];
  });
  if (selected.length === 0) {
    return [];
  }
  const lock = readYamlRecord(path.join(repoRoot, "pnpm-lock.yaml"), true);
  const importerKey = path.relative(repoRoot, packageDir).replaceAll(path.sep, "/") || ".";
  const importer = isRecord(lock.importers) ? lock.importers[importerKey] : undefined;
  selected = selected.filter(({ name, version }) => {
    const field = packageRuntimeDependencyField(packageJson, name);
    const resolved =
      isRecord(importer) && isRecord(importer[field]) ? importer[field][name] : undefined;
    if (
      !isRecord(resolved) ||
      typeof resolved.version !== "string" ||
      resolved.specifier !== packageJson[field]?.[name]
    ) {
      throw new Error(
        `patched runtime dependency is missing from the frozen pnpm importer: ${name}`,
      );
    }
    return resolved.version.split("(")[0] === version;
  });
  if (selected.length === 0) {
    return [];
  }
  const modules = readYamlRecord(path.join(repoRoot, "node_modules", ".modules.yaml"));
  const virtualStoreDir = modules.virtualStoreDir ?? ".pnpm";
  if (typeof virtualStoreDir !== "string") {
    throw new Error("frozen pnpm install has an invalid virtualStoreDir");
  }
  const storeDir = path.resolve(repoRoot, "node_modules", virtualStoreDir);
  const installedLock = readYamlRecord(path.join(storeDir, "lock.yaml"), true);
  const installedImporter = isRecord(installedLock.importers)
    ? installedLock.importers[importerKey]
    : undefined;
  const require = createRequire(path.join(packageDir, "package.json"));
  // A root declaration alone does not prove the installed bytes were patched.
  // Bind the patch hash, importer and actual installed package before packing it.
  return selected.map(({ name, version, selector, patchPath }) => {
    const patchHash =
      typeof patchPath === "string"
        ? createHash("sha256")
            .update(fs.readFileSync(path.resolve(repoRoot, patchPath)))
            .digest("hex")
        : "";
    const field = packageRuntimeDependencyField(packageJson, name);
    const resolved =
      isRecord(importer) && isRecord(importer[field]) ? importer[field][name] : undefined;
    const installed =
      isRecord(installedImporter) && isRecord(installedImporter[field])
        ? installedImporter[field][name]
        : undefined;
    if (
      !patchHash ||
      !isRecord(lock.patchedDependencies) ||
      lock.patchedDependencies[selector] !== patchHash ||
      !isRecord(installedLock.patchedDependencies) ||
      installedLock.patchedDependencies[selector] !== patchHash ||
      !isRecord(resolved) ||
      typeof resolved.version !== "string" ||
      !resolved.version.startsWith(`${version}(`) ||
      !resolved.version.includes(`(patch_hash=${patchHash})`) ||
      !isRecord(installed) ||
      installed.version !== resolved.version ||
      installed.specifier !== resolved.specifier
    ) {
      throw new Error(
        `patched runtime dependency requires a matching frozen pnpm install: ${selector}`,
      );
    }
    const candidate = require.resolve
      .paths(name)
      ?.map((dir) => path.join(dir, name))
      .find((dir) => fs.existsSync(path.join(dir, "package.json")));
    const dependencyPath = `${name}@${resolved.version}`;
    const locations =
      modules.nodeLinker === "isolated"
        ? [
            isolatedPnpmPackageDirectory(
              storeDir,
              dependencyPath,
              name,
              modules.virtualStoreDirMaxLength ?? (process.platform === "win32" ? 60 : 120),
            ),
          ]
        : modules.nodeLinker === "hoisted" && isRecord(modules.hoistedLocations)
          ? modules.hoistedLocations[dependencyPath]
          : undefined;
    if (
      !candidate ||
      !Array.isArray(locations) ||
      !locations.some(
        (location) =>
          typeof location === "string" &&
          (modules.nodeLinker === "isolated"
            ? location
            : fs.realpathSync(path.resolve(repoRoot, location))) === fs.realpathSync(candidate),
      )
    ) {
      throw new Error(`patched runtime dependency is not the frozen pnpm package: ${selector}`);
    }
    const installedPackage: unknown = JSON.parse(
      fs.readFileSync(path.join(candidate, "package.json"), "utf8"),
    );
    if (
      !isRecord(installedPackage) ||
      installedPackage.name !== name ||
      installedPackage.version !== version
    ) {
      throw new Error(`patched runtime dependency identity mismatch: ${selector}`);
    }
    return { name, version, packageDir: fs.realpathSync(candidate) };
  });
}

export function packPatchedDependencies(
  packageDir: string,
  dependencies: WorkspacePatchedDependency[],
) {
  if (dependencies.length === 0) {
    return { artifacts: [], cleanup: () => {} };
  }
  const outputDir = fs.mkdtempSync(path.join(packageDir, ".openclaw-patched-dependencies-"));
  const cleanup = () => fs.rmSync(outputDir, { recursive: true, force: true });
  try {
    const artifacts: NpmLocalPackageArtifact[] = dependencies.map(
      ({ name, version, packageDir: source }) => {
        const result = spawnNpmSync(
          [
            "pack",
            source,
            "--json",
            "--ignore-scripts",
            "--workspaces=false",
            "--pack-destination",
            outputDir,
          ],
          {
            cwd: packageDir,
            env: process.env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(`packing patched runtime dependency failed: ${name}@${version}`);
        }
        const output = JSON.parse(String(result.stdout));
        const entries = Array.isArray(output) ? output : Object.values(output);
        const packed = entries.length === 1 ? entries[0] : undefined;
        if (
          !packed ||
          packed.name !== name ||
          packed.version !== version ||
          typeof packed.filename !== "string" ||
          path.basename(packed.filename) !== packed.filename
        ) {
          throw new Error(`packed runtime dependency identity mismatch: ${name}@${version}`);
        }
        const tarball = path.join(outputDir, packed.filename);
        const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
        if (packed.integrity !== integrity) {
          throw new Error(`packed runtime dependency integrity mismatch: ${name}@${version}`);
        }
        return {
          name,
          version,
          spec: `file:./${path.relative(packageDir, tarball).replaceAll(path.sep, "/")}`,
          integrity,
        };
      },
    );
    return { artifacts, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
