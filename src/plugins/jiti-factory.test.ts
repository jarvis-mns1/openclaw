import fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createJiti as createRawJiti } from "jiti";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createJiti } from "./jiti-factory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const marker = "SYNTHETIC_INPUT_MAP_ONLY";

function createMapFixture(kind: "file" | "inline") {
  const root = tempDirs.make("openclaw-jiti-input-map-");
  const pluginRoot = join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  const filename = join(pluginRoot, "entry.ts");
  const mapFile = join(root, "synthetic-input.map");
  const map = JSON.stringify({
    version: 3,
    sources: ["synthetic-original.ts"],
    names: [],
    mappings: "AAAA",
    sourcesContent: [marker],
  });
  fs.writeFileSync(mapFile, map);
  const url =
    kind === "file"
      ? mapFile
      : `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
  const source = `export const result: number = 42;\n//# sourceMappingURL=${url}\n`;
  return { filename, mapFile, source };
}

function readOutputMap(code: string): unknown {
  const comments = [
    ...code.matchAll(/sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([^\s]+)/g),
  ];
  const encoded = expectDefined(comments.at(-1)?.[1], "generated output source map");
  const map: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  expect(map).toMatchObject({ version: 3 });
  return map;
}

describe("createJiti input source maps", () => {
  it.each(["file", "inline"] as const)(
    "blocks automatic %s maps through the factory and direct compiler transform",
    (kind) => {
      const fixture = createMapFixture(kind);
      const options = {
        tryNative: false,
        fsCache: false,
        moduleCache: false,
        sourceMaps: true,
      };
      const transformOptions = {
        source: fixture.source,
        filename: fixture.filename,
        ts: true,
        babel: { inputSourceMap: true, sourceMaps: "inline" },
      };
      const read = vi.spyOn(fs, "readFileSync");
      try {
        // The raw vendor control proves the synthetic map is valid and would be ingested.
        const raw = createRawJiti(fixture.filename, options).transform(transformOptions);
        expect(readOutputMap(raw)).toMatchObject({ sourcesContent: [marker] });
        if (kind === "file") {
          expect(read.mock.calls.some(([file]) => String(file) === fixture.mapFile)).toBe(true);
        }
        read.mockClear();

        const loader = createJiti(fixture.filename, options);
        const transformed = loader.transform(transformOptions);
        const direct = expectDefined(
          loader.options.transform,
          "direct compiler transform",
        )(transformOptions);
        expect(direct.error).toBeUndefined();
        for (const code of [transformed, direct.code]) {
          expect(readOutputMap(code)).toMatchObject({ sourcesContent: [fixture.source] });
        }
        expect(read.mock.calls.filter(([file]) => String(file) === fixture.mapFile)).toEqual([]);
      } finally {
        read.mockRestore();
      }
    },
  );

  it("preserves explicit map objects and emitted maps without reading a linked map", () => {
    const fixture = createMapFixture("file");
    const inputSourceMap = {
      version: 3,
      sources: ["explicit.ts"],
      names: [],
      mappings: "AAAA",
      sourcesContent: ["EXPLICIT_CALLER_OWNED_CONTENT"],
    };
    const read = vi.spyOn(fs, "readFileSync");
    try {
      const code = createJiti(fixture.filename, { fsCache: false, moduleCache: false }).transform({
        source: fixture.source,
        filename: fixture.filename,
        ts: true,
        babel: { inputSourceMap, sourceMaps: "inline" },
      });
      expect(readOutputMap(code)).toMatchObject({
        sourcesContent: ["EXPLICIT_CALLER_OWNED_CONTENT"],
      });
      expect(read.mock.calls.filter(([file]) => String(file) === fixture.mapFile)).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it("retains native module identity without invoking the source transformer", () => {
    const root = tempDirs.make("openclaw-jiti-native-identity-");
    const filename = join(root, "entry.ts");
    fs.writeFileSync(filename, "export const token: object = {};\n");
    const native: { token: object } = createRequire(import.meta.url)(filename);
    const options = {
      tryNative: true,
      fsCache: false,
      moduleCache: false,
    };
    const loader = createJiti(filename, options);
    const transform = vi.spyOn(loader.options, "transform");
    try {
      const loaded: { token: object } = loader(filename);
      expect(loaded.token).toBe(native.token);
      expect(transform).not.toHaveBeenCalled();

      // Adding transformOptions disables Jiti's early native path and splits identity.
      const forced: { token: object } = createRawJiti(filename, {
        ...options,
        transformOptions: { babel: { inputSourceMap: false } },
      })(filename);
      expect(forced.token).not.toBe(native.token);
    } finally {
      transform.mockRestore();
    }
  });
});
