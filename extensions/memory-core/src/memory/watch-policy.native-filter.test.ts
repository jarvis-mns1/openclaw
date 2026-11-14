import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as observation from "openclaw/plugin-sdk/file-access-runtime";
import type { WatchSubscription } from "openclaw/plugin-sdk/file-access-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";

vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
}));

it("prunes unrelated extra subtrees while observing selected edits through native events", async () => {
  const state = await createOpenClawTestState({ label: "memory-watch-native-filter" });
  const subscriptions: WatchSubscription[] = [];
  const visited = new Set<string>();
  const originalWatch = observation.watch;
  const observed = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    const subscription = originalWatch(authority, {
      ...options,
      mode: "events",
      exclude(entry) {
        visited.add(path.resolve(authority.rootDir, entry.path));
        return options.exclude?.(entry) ?? false;
      },
    });
    subscriptions.push(subscription);
    return subscription;
  });
  let watcher: MemoryFileWatcher | undefined;
  try {
    const extra = path.join(state.workspaceDir, "platform");
    for (const directory of ["controls", "observability/runbooks", "cache/deep"]) {
      await fs.mkdir(path.join(extra, directory), { recursive: true });
    }
    const note = path.join(extra, "controls", "keep.md");
    await fs.writeFile(note, "Original selected note.");
    await fs.writeFile(path.join(extra, "cache", "deep", "skip.md"), "Unselected note.");
    const baseline = createDeferred<void>();
    const edited = createDeferred<void>();
    const onUnavailable = vi.fn();
    watcher = new MemoryFileWatcher({
      runInBackgroundContext: AsyncLocalStorage.snapshot(),
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths: [
          { path: "platform", pattern: "{*.md,controls/*.md,observability/runbooks/*.md}" },
        ],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
        sync: { watchDebounceMs: 0 },
      },
      onUnavailable,
      onChange: async () => {
        const content = await fs.readFile(note, "utf8");
        if (content === "Original selected note.") {
          baseline.resolve();
        } else if (content === "Updated selected note.") {
          edited.resolve();
        }
      },
    });
    await watcher.start();
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.map((subscription) => subscription.health())).toEqual(
      subscriptions.map(() => expect.objectContaining({ state: "ready", mode: "events" })),
    );
    await baseline.promise;
    await fs.writeFile(note, "Updated selected note.");
    await edited.promise;
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(visited.has(note)).toBe(true);
    expect(visited.has(path.join(extra, "observability", "runbooks"))).toBe(true);
    expect(visited.has(path.join(extra, "cache", "deep"))).toBe(false);
    expect(visited.has(path.join(extra, "cache", "deep", "skip.md"))).toBe(false);
  } finally {
    try {
      await watcher?.close();
    } finally {
      observed.mockRestore();
      await state.cleanup();
    }
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  }
});
