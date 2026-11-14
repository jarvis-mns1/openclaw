import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryWatchPolicy } from "./watch-policy.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "memory-watch-policy" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});
const signal = () => new AbortController().signal;
function policy(extras: MemoryWorkspaceWatchRequest["settings"]["extraPaths"] = []) {
  return new MemoryWatchPolicy(state.workspaceDir, {
    extraPaths: extras,
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
}

it("observes root-entry links without following sources the indexer rejects", async () => {
  await fs.mkdir(state.path("target"));
  await fs.writeFile(state.path("target", "note.md"), "trusted");
  await fs.symlink(state.path("target"), path.join(state.workspaceDir, "memory"), "junction");
  await fs.symlink(state.path("target", "note.md"), path.join(state.workspaceDir, "MEMORY.md"));
  await fs.symlink(state.path("target"), state.path("extra-link"), "junction");
  const owner = policy([state.path("extra-link")]);
  const groups = await owner.observations(signal());
  const selected = groups.flatMap((group) =>
    group.selections.map((selection) => ({
      path: path.resolve(group.root.rootDir, selection.scope.path),
      ...selection,
    })),
  );
  expect(selected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: path.join(state.workspaceDir, "memory"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({
        path: path.join(state.workspaceDir, "MEMORY.md"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({ path: state.path("extra-link"), alias: true, core: false }),
    ]),
  );
  expect(selected.every((selection) => !selection.path.startsWith(state.path("target")))).toBe(
    true,
  );
  for (const group of groups) {
    for (const selection of group.selections.filter((entry) => entry.alias)) {
      expect(owner.exclude(group, { path: selection.scope.path, kind: "symlink" })).toBe(false);
    }
  }
});

it("observes the first intermediate alias separately and retains configured parent-alias behavior", async () => {
  await fs.mkdir(state.path("real", "workspace"), { recursive: true });
  await fs.mkdir(state.path("real", "extra"));
  await fs.symlink(state.path("real"), state.path("alias"), "junction");
  const owner = new MemoryWatchPolicy(state.path("alias", "workspace"), {
    extraPaths: [{ path: state.path("alias", "extra"), pattern: "notes/*.md" }],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
  const groups = await owner.observations(signal());
  const scopes = groups.flatMap((group) =>
    owner.scopes(group).map((scope) => path.resolve(group.root.rootDir, scope.path)),
  );
  expect(scopes).toContain(state.path("alias"));
  expect(scopes).toContain(state.path("real", "extra"));
  expect(scopes).not.toContain(state.path("alias", "extra"));
  const group = groups.find((entry) =>
    entry.selections.some((selection) => selection.resolved === state.path("real", "extra")),
  )!;
  const relative = (name: string) =>
    path.relative(group.root.rootDir, state.path("real", "extra", name));
  expect(owner.exclude(group, { path: relative("notes"), kind: "directory" })).toBe(false);
  expect(owner.exclude(group, { path: relative("drafts"), kind: "directory" })).toBe(true);
  expect(owner.exclude(group, { path: relative("notes/keep.md"), kind: "file" })).toBe(false);
  expect(owner.select(group, relative("notes/keep.md"), false)).toBeDefined();
});

it("retains successful Roots across missing-descendant creation and never repins a replaced authority", async () => {
  await fs.mkdir(state.path("outer"));
  const extra = state.path("outer", "missing", "notes");
  const owner = policy([{ path: extra, pattern: "*.md" }]);
  const first = await owner.observations(signal());
  const group = first.find((entry) =>
    entry.selections.some((selection) => selection.lexical === extra),
  )!;
  for (const directory of [state.path("outer", "missing"), extra]) {
    expect(
      owner.exclude(group, {
        path: path.relative(group.root.rootDir, directory),
        kind: "directory",
      }),
    ).toBe(false);
  }
  await fs.mkdir(state.path("outer", "missing", "notes"), { recursive: true });
  const next = await owner.observations(signal());
  expect(next.map((entry) => entry.root)).toEqual(first.map((entry) => entry.root));
  expect(
    owner.exclude(group, {
      path: path.relative(group.root.rootDir, path.join(extra, "keep.md")),
      kind: "file",
    }),
  ).toBe(false);
  expect(
    owner.exclude(group, {
      path: path.relative(group.root.rootDir, path.join(extra, "cache")),
      kind: "directory",
    }),
  ).toBe(true);
  // outer/missing was absent during first admission; authority remains outer.
  await fs.rename(state.path("outer"), state.path("outer-old"));
  await fs.mkdir(state.path("outer", "missing", "notes"), { recursive: true });
  await expect(owner.observations(signal())).rejects.toBeDefined();
});

it("retains partial Root admission when a later configured boundary temporarily fails", async () => {
  await fs.mkdir(state.path("first"));
  await fs.mkdir(state.path("second"));
  const owner = policy([state.path("first", "notes"), state.path("second", "notes")]);
  const original = fs.lstat.bind(fs);
  const failure = new Error("admission denied");
  const stat = vi
    .spyOn(fs, "lstat")
    .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === state.path("second")) {
        throw failure;
      }
      return await original(...args);
    });
  await expect(owner.observations(signal())).rejects.toBe(failure);
  stat.mockRestore();
  await fs.rename(state.path("first"), state.path("first-old"));
  await fs.mkdir(state.path("first"));
  // If failure discarded successful admissions, this would silently repin first.
  await expect(owner.observations(signal())).rejects.toBeDefined();
});

it("selects configured patterns and multimodal files while pruning unrelated descendants", async () => {
  const extra = state.path("extra");
  const owner = new MemoryWatchPolicy(state.workspaceDir, {
    extraPaths: [{ path: extra, pattern: "..notes/**/*" }, state.path("other")],
    multimodal: { enabled: true, modalities: ["image", "audio"], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
  const group = (await owner.observations(signal())).find((entry) =>
    entry.selections.some((selection) => selection.lexical === extra),
  )!;
  const relative = (name: string) => path.relative(group.root.rootDir, path.join(extra, name));
  for (const file of ["..notes/note.md", "..notes/PHOTO.PNG", "..notes/voice.WAV"]) {
    expect(owner.exclude(group, { path: relative(file), kind: "file" })).toBe(false);
    expect(owner.select(group, relative(file), false)).toMatchObject({ relative: relative(file) });
  }
  for (const file of ["drafts/skip.md", "..notes/metadata.json", "node_modules/pkg/note.md"]) {
    expect(owner.exclude(group, { path: relative(file), kind: "file" })).toBe(true);
    expect(owner.select(group, relative(file), false)).toBeUndefined();
  }
  for (const directory of ["drafts", "node_modules", ".venv"]) {
    expect(owner.exclude(group, { path: relative(directory), kind: "directory" })).toBe(true);
  }
  expect(owner.exclude(group, { path: relative("..notes"), kind: "directory" })).toBe(false);
  expect(owner.exclude(group, { path: relative("nested-link"), kind: "symlink" })).toBe(true);
});

it("combines overlapping extra patterns without narrowing core selections", async () => {
  const owner = policy([
    { path: state.workspaceDir, pattern: "controls/*.md" },
    { path: state.workspaceDir, pattern: "observability/runbooks/*.md" },
  ]);
  const group = (await owner.observations(signal())).find((entry) =>
    entry.selections.some((selection) => selection.lexical === state.workspaceDir),
  )!;
  const relative = (name: string) =>
    path.relative(group.root.rootDir, path.join(state.workspaceDir, name));
  for (const directory of [
    "",
    "memory/cache/deep",
    "controls",
    "observability",
    "observability/runbooks",
  ]) {
    expect(owner.exclude(group, { path: relative(directory), kind: "directory" }), directory).toBe(
      false,
    );
  }
  for (const file of [
    "MEMORY.md",
    "USER.md",
    "memory/cache/deep/note.md",
    "controls/keep.md",
    "observability/runbooks/keep.md",
  ]) {
    expect(owner.exclude(group, { path: relative(file), kind: "file" }), file).toBe(false);
    expect(owner.select(group, relative(file), false), file).toBeDefined();
  }
  for (const directory of ["cache", "controls/deep", "observability/metrics"]) {
    expect(owner.exclude(group, { path: relative(directory), kind: "directory" }), directory).toBe(
      true,
    );
  }
  for (const file of ["skip.md", "controls/skip.json", "memory/node_modules/note.md"]) {
    expect(owner.exclude(group, { path: relative(file), kind: "file" }), file).toBe(true);
  }
});

it("preserves nested selections through a broader root's excluded branch", async () => {
  const extra = state.path("outer", "platform");
  await fs.mkdir(state.path("outer"));
  const nested = path.join(extra, "cache", "selected");
  const owner = policy([
    { path: extra, pattern: "controls/*.md" },
    { path: nested, pattern: "*.md" },
  ]);
  const groups = await owner.observations(signal());
  const broader = groups.find((entry) =>
    entry.selections.some((selection) => selection.lexical === extra),
  )!;
  const group = groups.find((entry) =>
    entry.selections.some((selection) => selection.lexical === nested),
  )!;
  expect(
    owner.exclude(broader, {
      path: path.relative(broader.root.rootDir, path.join(extra, "cache")),
      kind: "directory",
    }),
  ).toBe(true);
  for (const directory of [extra, path.join(extra, "cache"), nested]) {
    expect(
      owner.exclude(group, {
        path: path.relative(group.root.rootDir, directory),
        kind: "directory",
      }),
    ).toBe(false);
  }
  expect(
    owner.exclude(group, {
      path: path.relative(group.root.rootDir, path.join(nested, "keep.md")),
      kind: "file",
    }),
  ).toBe(false);
  expect(
    owner.exclude(group, {
      path: path.relative(group.root.rootDir, path.join(extra, "cache", "unselected")),
      kind: "directory",
    }),
  ).toBe(true);
});
