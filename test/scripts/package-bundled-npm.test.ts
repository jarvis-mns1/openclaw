import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundledDependencyErrors } from "../../scripts/lib/package-bundled-dependencies.mts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const NPM = "node_modules/npm/";
// Independent manifest/entry expectations from the reviewed input archives.
const PACKAGES = [
  ["glob", "14.0.2", "dist/commonjs/index.min.js", "dist/esm/index.min.js"],
  ["minimatch", "11.0.1", "dist/commonjs/index.js", "dist/esm/index.js"],
  ["path-scurry", "3.0.0", "dist/commonjs/index.js", "dist/esm/index.js"],
  ["@isaacs/nonrecursive-glob-match", "1.0.1", "dist/commonjs/index.js", "dist/esm/index.js"],
  ["ip-address", "10.7.5", "dist/ip-address.js", "dist/ip-address.js"],
  ["brace-expansion", "5.0.12", "dist/commonjs/index.js", "dist/esm/index.js"],
  ["postcss-selector-parser", "7.1.6", "dist/index.js", "dist/index.js"],
  ["undici", "6.29.1", "index.js", "index.js"],
] as const;

function fixture() {
  const packageRoot = makeTempDir(tempDirs, "openclaw-bundled-npm-");
  const entries = new Set<string>();
  const write = (file: string, content: string) => {
    const target = path.join(packageRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    entries.add(file);
  };
  const writeJson = (file: string, value: unknown) => write(file, JSON.stringify(value));
  const readText = (file: string) => readFileSync(path.join(packageRoot, file), "utf8");
  const packageJson: Record<string, unknown> = {
    name: "openclaw-fixture",
    dependencies: { npm: "12.2.2" },
    bundleDependencies: ["npm"],
  };
  writeJson("package.json", packageJson);
  writeJson(`${NPM}package.json`, {
    name: "npm",
    version: "12.2.2",
    main: "./index.js",
    bin: { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" },
    exports: { ".": [{ default: "./index.js" }, "./index.js"], "./package.json": "./package.json" },
    dependencies: { glob: "14.0.2", minimatch: "11.0.1" },
    bundleDependencies: ["glob", "minimatch"],
  });
  // Resolution must never execute npm or any nested package code.
  for (const file of ["index.js", "bin/npm-cli.js", "bin/npx-cli.js", "lib/cli.js"]) {
    write(`${NPM}${file}`, 'throw new Error("package code must not execute");\n');
  }
  for (const [name, version, cjs, esm] of PACKAGES) {
    const prefix = `${NPM}node_modules/${name}/`;
    writeJson(`${prefix}package.json`, {
      name,
      version,
      main: `./${cjs}`,
      exports: { ".": { import: `./${esm}`, require: `./${cjs}` } },
    });
    for (const file of new Set([cjs, esm])) {
      write(`${prefix}${file}`, 'throw new Error("nested package code must not execute");\n');
    }
  }
  return {
    packageRoot,
    packageJson,
    entries,
    write,
    writeJson,
    editManifest(
      file: string,
      update: (manifest: Record<string, unknown>) => Record<string, unknown>,
    ) {
      writeJson(file, update(JSON.parse(readText(file))));
    },
    remove(file: string) {
      rmSync(path.join(packageRoot, file));
      entries.delete(file);
    },
    check() {
      return collectBundledDependencyErrors({
        packageJson,
        packageRoot,
        entries,
        files: [...entries],
        readText,
      });
    },
  };
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("patched npm bundle guard", () => {
  it.each(["bundleDependencies", "bundledDependencies", "all"])(
    "accepts the patched bundle using %s without loading package code",
    (field) => {
      const input = fixture();
      delete input.packageJson.bundleDependencies;
      input.packageJson[field === "all" ? "bundleDependencies" : field] =
        field === "all" ? true : ["npm"];
      expect(input.check()).toEqual([]);
    },
  );

  it("does not impose the npm contract on packages without an npm dependency", () => {
    const input = fixture();
    input.packageJson.dependencies = {};
    input.packageJson.bundleDependencies = [];
    expect(input.check()).toEqual([]);
  });

  it.each([undefined, false, []])("rejects unbundled npm with marker %s", (marker) => {
    const input = fixture();
    input.packageJson.bundleDependencies = marker;
    expect(input.check()).toContain(
      "package.json dependencies.npm must be listed in bundleDependencies because its patched runtime must not be replaced by the registry package",
    );
  });

  it.each([null, "^12.2.2", "12.2.1", "12.2.3", "npm:npm@12.2.2"])(
    "rejects unsupported or malformed root pin %s",
    (version) => {
      const input = fixture();
      input.packageJson.dependencies = { npm: version };
      expect(input.check()).toContain(
        "package.json dependencies.npm must be pinned to patched 12.2.2",
      );
    },
  );

  it.each([
    {
      content: undefined,
      message: "package.json dependencies.npm must be bundled in node_modules/npm",
    },
    { content: "{", message: "unreadable bundled npm package.json:" },
    { content: "null", message: "bundled npm package.json must name npm" },
    { content: '{"name":"not-npm"}', message: "bundled npm package.json must name npm" },
  ])("rejects a missing or malformed npm manifest: $content", ({ content, message }) => {
    const input = fixture();
    if (content === undefined) {
      input.remove(`${NPM}package.json`);
    } else {
      input.write(`${NPM}package.json`, content);
    }
    expect(input.check().join("\n")).toContain(message);
  });

  it("rejects npm parent version and dependency pin drift", () => {
    const input = fixture();
    input.editManifest(`${NPM}package.json`, (manifest) => ({
      ...manifest,
      version: "12.2.1",
      dependencies: { glob: "^13.0.6", minimatch: "^10.2.5" },
      bundleDependencies: [],
    }));
    expect(input.check()).toEqual(
      expect.arrayContaining([
        "bundled npm must be version 12.2.2",
        "bundled npm dependencies.glob must be pinned to 14.0.2",
        "bundled npm dependencies.minimatch must be pinned to 11.0.1",
        "bundled npm must retain glob in bundleDependencies",
        "bundled npm must retain minimatch in bundleDependencies",
      ]),
    );
  });

  it.each(PACKAGES)("rejects nested version drift for %s", (name, version) => {
    const input = fixture();
    input.editManifest(`${NPM}node_modules/${name}/package.json`, (manifest) => ({
      ...manifest,
      version: "0.0.0",
    }));
    expect(input.check()).toContain(`bundled npm ${name} must be version ${version}`);
  });

  it.each(["{", "null", '{"name":"wrong","version":"14.0.2"}'])(
    "rejects malformed nested identity %s",
    (content) => {
      const input = fixture();
      input.write(`${NPM}node_modules/glob/package.json`, content);
      expect(input.check().join("\n")).toMatch(
        /unreadable bundled npm glob|bundled npm glob must be version/,
      );
    },
  );

  it.each(["package.json", "dist/commonjs/index.min.js", "dist/esm/index.min.js"])(
    "rejects a missing nested %s even if Node returns a resolution URL",
    (file) => {
      const input = fixture();
      const missing = `${NPM}node_modules/glob/${file}`;
      input.remove(missing);
      expect(input.check()).toContain(`bundled npm is missing required runtime entry ${missing}`);
    },
  );

  it.each(["index.js", "bin/npm-cli.js", "bin/npx-cli.js", "lib/cli.js"])(
    "rejects a missing npm runtime entry %s",
    (file) => {
      const input = fixture();
      input.remove(`${NPM}${file}`);
      expect(input.check()).toContain(
        `bundled npm is missing required runtime entry ${NPM}${file}`,
      );
    },
  );

  it("rejects a nested package hoisted outside npm's bundle", () => {
    const input = fixture();
    rmSync(path.join(input.packageRoot, `${NPM}node_modules/undici`), { recursive: true });
    input.writeJson("node_modules/undici/package.json", {
      name: "undici",
      version: "6.29.1",
      main: "index.js",
    });
    input.write("node_modules/undici/index.js", "throw new Error('must not execute');");
    expect(input.check()).toEqual(
      expect.arrayContaining([
        `bundled npm require undici must resolve to ${NPM}node_modules/undici/index.js`,
        `bundled npm import undici must resolve to ${NPM}node_modules/undici/index.js`,
      ]),
    );
  });

  it.each(["import", "require"])("rejects redirected %s exports", (condition) => {
    const input = fixture();
    const prefix = `${NPM}node_modules/glob/`;
    input.write(`${prefix}other.js`, "throw new Error('must not execute');");
    input.editManifest(`${prefix}package.json`, (manifest) => ({
      ...manifest,
      exports: {
        ".": {
          import: "./dist/esm/index.min.js",
          require: "./dist/commonjs/index.min.js",
          [condition]: "./other.js",
        },
      },
    }));
    const expected =
      condition === "import" ? "dist/esm/index.min.js" : "dist/commonjs/index.min.js";
    expect(input.check()).toContain(
      `bundled npm ${condition} glob must resolve to ${prefix}${expected}`,
    );
  });

  it("rejects a main entry resolving above its package directory", () => {
    const input = fixture();
    input.write(`${NPM}node_modules/outside.js`, "throw new Error('must not execute');");
    input.editManifest(`${NPM}node_modules/undici/package.json`, (manifest) => {
      const { exports: _exports, ...rest } = manifest;
      return { ...rest, main: "../outside.js" };
    });
    expect(input.check()).toContain(
      `bundled npm require undici must resolve to ${NPM}node_modules/undici/index.js`,
    );
  });

  it("rejects a symlinked runtime entry outside the npm bundle", () => {
    const input = fixture();
    const entry = `${NPM}node_modules/undici/index.js`;
    input.write("outside.js", "throw new Error('must not execute');");
    input.remove(entry);
    symlinkSync(path.join(input.packageRoot, "outside.js"), path.join(input.packageRoot, entry));
    input.entries.add(entry);
    expect(input.check()).toContain(
      `bundled npm runtime entry ${entry} is not a regular file inside its bundle`,
    );
  });

  it("rejects a deeper copy that could shadow the patched package", () => {
    const input = fixture();
    const entry = `${NPM}node_modules/glob/node_modules/minimatch/package.json`;
    input.writeJson(entry, { name: "minimatch", version: "10.2.5" });
    expect(input.check()).toContain(
      `bundled npm has an unexpected nested copy of minimatch: ${entry}`,
    );
  });

  it("rejects altered npm entry-point metadata", () => {
    const input = fixture();
    input.editManifest(`${NPM}package.json`, (manifest) => ({
      ...manifest,
      bin: { npm: "../../outside.js" },
    }));
    expect(input.check()).toContain(
      "bundled npm must expose its supported main, npm, and npx entries",
    );
  });
});
