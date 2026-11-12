import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coerceErrorMessage } from "./error-format.mts";
import { isRecord } from "./record-shared.mjs";

export const PATCHED_NPM_NAME = "npm";
export const PATCHED_NPM_VERSION = "12.2.2";

// npm 12.2.2 plus the four reviewed replacement archives. This is an identity
// and resolution contract; the patch derivation receipt owns byte provenance.
const NESTED_PACKAGES = [
  {
    name: "glob",
    version: "14.0.2",
    cjs: "dist/commonjs/index.min.js",
    esm: "dist/esm/index.min.js",
  },
  {
    name: "minimatch",
    version: "11.0.1",
    cjs: "dist/commonjs/index.js",
    esm: "dist/esm/index.js",
  },
  {
    name: "path-scurry",
    version: "3.0.0",
    cjs: "dist/commonjs/index.js",
    esm: "dist/esm/index.js",
  },
  {
    name: "@isaacs/nonrecursive-glob-match",
    version: "1.0.1",
    cjs: "dist/commonjs/index.js",
    esm: "dist/esm/index.js",
  },
  {
    name: "ip-address",
    version: "10.7.5",
    cjs: "dist/ip-address.js",
    esm: "dist/ip-address.js",
  },
  {
    name: "brace-expansion",
    version: "5.0.12",
    cjs: "dist/commonjs/index.js",
    esm: "dist/esm/index.js",
  },
  {
    name: "postcss-selector-parser",
    version: "7.1.6",
    cjs: "dist/index.js",
    esm: "dist/index.js",
  },
  { name: "undici", version: "6.29.1", cjs: "index.js", esm: "index.js" },
] as const;

export const PATCHED_NPM_RUNTIME_SPECIFIERS = [
  PATCHED_NPM_NAME,
  ...NESTED_PACKAGES.map(({ name }) => name),
];

export function collectPatchedNpmArtifactErrors({
  declaredVersion,
  manifest,
  entries,
  packageRoot,
  readText,
  importResolutions,
}: {
  declaredVersion: unknown;
  manifest: Record<string, unknown>;
  entries: ReadonlySet<string>;
  packageRoot: string;
  readText: (file: string) => string;
  importResolutions: Record<string, string> | null;
}): string[] {
  const errors: string[] = [];
  if (declaredVersion !== PATCHED_NPM_VERSION) {
    errors.push(`package.json dependencies.npm must be pinned to patched ${PATCHED_NPM_VERSION}`);
  }
  if (manifest.version !== PATCHED_NPM_VERSION) {
    errors.push(`bundled npm must be version ${PATCHED_NPM_VERSION}`);
  }
  if (
    manifest.main !== "./index.js" ||
    !isRecord(manifest.bin) ||
    manifest.bin.npm !== "bin/npm-cli.js" ||
    manifest.bin.npx !== "bin/npx-cli.js"
  ) {
    errors.push("bundled npm must expose its supported main, npm, and npx entries");
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  for (const [name, version] of [
    ["glob", "14.0.2"],
    ["minimatch", "11.0.1"],
  ] as const) {
    if (dependencies[name] !== version) {
      errors.push(`bundled npm dependencies.${name} must be pinned to ${version}`);
    }
    if (bundled !== true && (!Array.isArray(bundled) || !bundled.includes(name))) {
      errors.push(`bundled npm must retain ${name} in bundleDependencies`);
    }
  }

  let root: string;
  try {
    root = realpathSync(packageRoot);
  } catch (error) {
    return [...errors, `unreadable npm bundle root: ${coerceErrorMessage(error)}`];
  }
  const prefix = "node_modules/npm/";
  const npmRoot = path.join(root, prefix);
  const rootRequire = createRequire(path.join(root, "package.json"));
  const npmRequire = createRequire(path.join(npmRoot, "package.json"));
  const checkFile = (file: string): boolean => {
    if (!entries.has(file)) {
      errors.push(`bundled npm is missing required runtime entry ${file}`);
      return false;
    }
    const expected = path.join(root, file);
    try {
      if (realpathSync(expected) === expected && statSync(expected).isFile()) {
        return true;
      }
    } catch {
      // A listed archive entry must also exist as a regular extracted bundle file.
    }
    errors.push(`bundled npm runtime entry ${file} is not a regular file inside its bundle`);
    return false;
  };
  const checkRequire = (from: NodeJS.Require, specifier: string, file: string) => {
    try {
      if (from.resolve(specifier) === path.join(root, file)) {
        return;
      }
    } catch {
      // Resolution must not fall back to a registry-installed or host package.
    }
    errors.push(`bundled npm require ${specifier} must resolve to ${file}`);
  };
  const checkImport = (specifier: string, file: string) => {
    if (importResolutions?.[specifier] !== pathToFileURL(path.join(root, file)).href) {
      errors.push(`bundled npm import ${specifier} must resolve to ${file}`);
    }
  };

  for (const file of [
    "package.json",
    "index.js",
    "bin/npm-cli.js",
    "bin/npx-cli.js",
    "lib/cli.js",
  ]) {
    checkFile(`${prefix}${file}`);
  }
  checkRequire(rootRequire, "npm", `${prefix}index.js`);
  checkImport("npm", `${prefix}index.js`);
  for (const { name, version, cjs, esm } of NESTED_PACKAGES) {
    const nestedPrefix = `${prefix}node_modules/${name}/`;
    const manifestPath = `${nestedPrefix}package.json`;
    if (checkFile(manifestPath)) {
      try {
        const nested: unknown = JSON.parse(readText(manifestPath));
        if (!isRecord(nested) || nested.name !== name || nested.version !== version) {
          errors.push(`bundled npm ${name} must be version ${version}`);
        }
      } catch (error) {
        errors.push(`unreadable bundled npm ${name} package.json: ${coerceErrorMessage(error)}`);
      }
    }
    for (const file of new Set([cjs, esm])) {
      checkFile(`${nestedPrefix}${file}`);
    }
    checkRequire(npmRequire, name, `${nestedPrefix}${cjs}`);
    checkImport(name, `${nestedPrefix}${esm}`);
    // The reviewed npm archive has one copy of each protected package. A deeper
    // copy can shadow it for a consumer even when npm-root resolution passes.
    for (const entry of entries) {
      if (
        entry.startsWith(prefix) &&
        entry.endsWith(`/node_modules/${name}/package.json`) &&
        entry !== manifestPath
      ) {
        errors.push(`bundled npm has an unexpected nested copy of ${name}: ${entry}`);
      }
    }
  }
  return errors;
}
