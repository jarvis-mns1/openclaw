import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("carried memory watch admission regressions", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider, createConfig, getFreshManager } = fixture;

  // Admission tests inject dirty notifications, not sync or database behavior.
  function markMemoryDirty(manager: MemoryIndexManager): void {
    (manager as unknown as { dirty: boolean }).dirty = true;
  }

  function indexedMemoryPath(manager: MemoryIndexManager, name: string): unknown {
    const db = Reflect.get(manager, "db") as DatabaseSync;
    return db
      .prepare("SELECT path FROM memory_index_sources WHERE path = ? AND source = 'memory'")
      .get(`memory/${name}`);
  }

  it.each(["batch-test", "batch-wide-test"])(
    "runs a follow-up watch sync when %s embedding is already active",
    async (providerId) => {
      const manager = await getFreshManager(
        createConfig({ provider: providerId, batchEnabled: true, vectorEnabled: false }),
        "cli",
      );
      const gate = createDeferred<void>();
      const pending: Promise<void>[] = [];
      try {
        await manager.sync({ reason: "watch-race-baseline", force: true });
        await fs.writeFile(
          path.join(fixture.paths.memory, "2026-01-12.md"),
          "# Log\nAlpha memory line changed while indexing.\n",
        );
        markMemoryDirty(manager);
        provider.providerRuntimeBatchGate = gate.promise;
        pending.push(manager.sync({ reason: "watch-race-active" }));
        await vi.waitFor(() => expect(provider.providerRuntimeActiveBatchCalls).toBe(1));

        await fs.writeFile(
          path.join(fixture.paths.memory, "watch-race-late.md"),
          "# Log\nLate watcher convergence marker.\n",
        );
        markMemoryDirty(manager);
        pending.push(manager.sync({ reason: "watch" }));

        gate.resolve();
        await Promise.all(pending);
        expect(indexedMemoryPath(manager, "watch-race-late.md")).toEqual({
          path: "memory/watch-race-late.md",
        });
        expect(manager.status().dirty).toBe(false);
      } finally {
        gate.resolve();
        provider.providerRuntimeBatchGate = null;
        await Promise.allSettled(pending);
        await manager.close();
      }
    },
  );

  it("retries watch admission when a queued session sync takes the slot", async () => {
    const manager = await getFreshManager(
      createConfig({
        provider: "none",
        vectorEnabled: false,
        sources: ["memory", "sessions"],
        sessionMemory: true,
      }),
      "cli",
    );
    await manager.sync({ reason: "watch-admission-baseline", force: true });
    const active = createDeferred<void>();
    const session = createDeferred<void>();
    const owner = manager as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSync = vi
      .spyOn(owner, "runSync")
      .mockReturnValueOnce(active.promise)
      .mockReturnValueOnce(session.promise);
    const pending: Promise<void>[] = [];
    try {
      pending.push(manager.sync({ reason: "watch-admission-active" }));
      await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
      await fs.writeFile(
        path.join(fixture.paths.memory, "watch-admission-late.md"),
        "# Log\nWatcher admission retry marker.\n",
      );
      markMemoryDirty(manager);
      pending.push(
        manager.sync({
          reason: "watch-admission-session",
          sessions: [{ agentId: "main", sessionId: "watch-admission-session" }],
        }),
        manager.sync({ reason: "watch" }),
      );

      active.resolve();
      await vi.waitFor(() => {
        expect(runSync).toHaveBeenCalledTimes(2);
        expect(runSync.mock.calls[1]?.[0]?.reason).toBe("queued-sessions");
      });
      session.resolve();
      await Promise.all(pending);
      expect(runSync.mock.calls.map(([params]) => params?.reason)).toContain("watch");
      expect(indexedMemoryPath(manager, "watch-admission-late.md")).toEqual({
        path: "memory/watch-admission-late.md",
      });
      expect(manager.status().dirty).toBe(false);
    } finally {
      active.resolve();
      session.resolve();
      await Promise.allSettled(pending);
      runSync.mockRestore();
      await manager.close();
    }
  });

  it.each(["full", "targeted"] as const)(
    "indexes memory and requested sessions when queued watch scopes differ (%s first)",
    async (firstScope) => {
      const manager = await getFreshManager(
        createConfig({
          provider: "none",
          vectorEnabled: false,
          sources: ["memory", "sessions"],
          sessionMemory: true,
        }),
        "cli",
      );
      await manager.sync({ reason: "mixed-watch-baseline", force: true });
      const active = createDeferred<void>();
      const owner = manager as unknown as {
        runSync: (params?: MemorySyncParams) => Promise<void>;
      };
      const runSync = vi.spyOn(owner, "runSync").mockReturnValueOnce(active.promise);
      const pending: Promise<void>[] = [];
      try {
        pending.push(manager.sync({ reason: "mixed-watch-active" }));
        await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
        await fs.writeFile(
          path.join(fixture.paths.memory, "mixed-watch-late.md"),
          "# Log\nFull watch scope must index this memory file.\n",
        );
        markMemoryDirty(manager);
        await fixture.seedSessionTranscript({
          sessionId: "mixed-watch-session",
          messages: [{ role: "user", content: "Targeted watch session marker.", timestamp: 1 }],
        });
        const full: MemorySyncParams = { reason: "watch" };
        const targeted: MemorySyncParams = {
          reason: "watch",
          sessions: [{ agentId: "main", sessionId: "mixed-watch-session" }],
        };
        for (const request of firstScope === "full" ? [full, targeted] : [targeted, full]) {
          pending.push(manager.sync(request));
        }
        active.resolve();
        await Promise.all(pending);

        expect(indexedMemoryPath(manager, "mixed-watch-late.md")).toEqual({
          path: "memory/mixed-watch-late.md",
        });
        const db = Reflect.get(manager, "db") as DatabaseSync;
        expect(
          db.prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions'").all(),
        ).toEqual([{ path: "sessions/main/mixed-watch-session.jsonl" }]);
        expect(manager.status().dirty).toBe(false);
      } finally {
        active.resolve();
        await Promise.allSettled(pending);
        runSync.mockRestore();
        await manager.close();
      }
    },
  );

  it("indexes another change arriving during the queued watch follow-up", async () => {
    const manager = await getFreshManager(
      createConfig({ provider: "batch-test", batchEnabled: true, vectorEnabled: false }),
      "cli",
    );
    const active = createDeferred<void>();
    const followUp = createDeferred<void>();
    const pending: Promise<void>[] = [];
    try {
      await manager.sync({ reason: "watch-follow-up-baseline", force: true });
      const baselineCalls = provider.providerRuntimeBatchCalls.length;
      await fs.writeFile(
        path.join(fixture.paths.memory, "2026-01-12.md"),
        "# Log\nAlpha changed before the first pass.\n",
      );
      markMemoryDirty(manager);
      provider.providerRuntimeBatchGate = active.promise;
      pending.push(manager.sync({ reason: "watch-follow-up-active" }));
      await vi.waitFor(() => expect(provider.providerRuntimeActiveBatchCalls).toBe(1));

      await fs.writeFile(
        path.join(fixture.paths.memory, "first-follow-up.md"),
        "# Log\nFirst follow-up marker.\n",
      );
      markMemoryDirty(manager);
      pending.push(manager.sync({ reason: "watch" }));
      provider.providerRuntimeBatchGate = followUp.promise;
      active.resolve();
      await vi.waitFor(() => {
        expect(provider.providerRuntimeBatchCalls).toHaveLength(baselineCalls + 1);
        expect(provider.providerRuntimeActiveBatchCalls).toBe(1);
      });

      await fs.writeFile(
        path.join(fixture.paths.memory, "second-follow-up.md"),
        "# Log\nSecond follow-up marker.\n",
      );
      markMemoryDirty(manager);
      pending.push(manager.sync({ reason: "watch" }));
      provider.providerRuntimeBatchGate = null;
      followUp.resolve();
      await Promise.all(pending);

      for (const name of ["first-follow-up.md", "second-follow-up.md"]) {
        expect(indexedMemoryPath(manager, name)).toEqual({ path: `memory/${name}` });
      }
      expect(manager.status().dirty).toBe(false);
    } finally {
      active.resolve();
      followUp.resolve();
      provider.providerRuntimeBatchGate = null;
      await Promise.allSettled(pending);
      await manager.close();
    }
  });

  it("indexes a pending file after the active watch pass rejects", async () => {
    const manager = await getFreshManager(
      createConfig({ provider: "none", vectorEnabled: false }),
      "cli",
    );
    await manager.sync({ reason: "watch-failure-baseline", force: true });
    const active = createDeferred<void>();
    const failure = new Error("watch indexing failed");
    const owner = manager as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSync = vi.spyOn(owner, "runSync").mockReturnValueOnce(active.promise);
    const pending: Promise<void>[] = [];
    try {
      pending.push(manager.sync({ reason: "watch" }));
      await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
      await fs.writeFile(
        path.join(fixture.paths.memory, "watch-after-failure.md"),
        "# Log\nPending alpha memory survives an earlier failed pass.\n",
      );
      markMemoryDirty(manager);
      pending.push(manager.sync({ reason: "watch" }));
      const settled = Promise.allSettled(pending);
      active.reject(failure);
      const outcomes = await settled;

      expect(indexedMemoryPath(manager, "watch-after-failure.md")).toEqual({
        path: "memory/watch-after-failure.md",
      });
      expect(manager.status().dirty).toBe(false);
      expect(outcomes).toEqual(pending.map(() => ({ status: "rejected", reason: failure })));
    } finally {
      active.resolve();
      await Promise.allSettled(pending);
      runSync.mockRestore();
      await manager.close();
    }
  });

  it("releases pending watch work when the manager closes", async () => {
    const manager = await getFreshManager(
      createConfig({ provider: "batch-test", batchEnabled: true, vectorEnabled: false }),
      "cli",
    );
    const active = createDeferred<void>();
    const pending: Promise<void>[] = [];
    try {
      await manager.sync({ reason: "watch-close-baseline", force: true });
      const baselineCalls = provider.providerRuntimeBatchCalls.length;
      await fs.writeFile(
        path.join(fixture.paths.memory, "2026-01-12.md"),
        "# Log\nAlpha changed before closing.\n",
      );
      markMemoryDirty(manager);
      provider.providerRuntimeBatchGate = active.promise;
      pending.push(manager.sync({ reason: "watch-close-active" }));
      await vi.waitFor(() => expect(provider.providerRuntimeActiveBatchCalls).toBe(1));
      await fs.writeFile(
        path.join(fixture.paths.memory, "must-not-index-after-close.md"),
        "# Log\nPending watch work.\n",
      );
      markMemoryDirty(manager);
      pending.push(manager.sync({ reason: "watch" }), manager.close());
      active.resolve();
      await Promise.all(pending);

      await manager.sync({ reason: "watch" });
      expect(provider.providerRuntimeBatchCalls).toHaveLength(baselineCalls + 1);
      expect(provider.providerRuntimeActiveBatchCalls).toBe(0);
      expect(provider.providerCloseCalls).toBe(1);
    } finally {
      active.resolve();
      provider.providerRuntimeBatchGate = null;
      await Promise.allSettled(pending);
      await manager.close();
    }
  });

  it.each(
    ["targeted", "full"].flatMap((scope) =>
      ["agent:main:memory:rollover-race", "global"].map((sessionKey) => ({ scope, sessionKey })),
    ),
  )(
    "reconciles $sessionKey replacement arriving during a $scope embedding pass",
    async ({ scope, sessionKey }) => {
      await fixture.seedSessionTranscript({
        sessionId: "rollover-previous",
        sessionKey,
        messages: [{ role: "user", content: "Previous generation alpha.", timestamp: 1 }],
      });
      const manager = await getFreshManager(
        createConfig({
          provider: "batch-test",
          batchEnabled: true,
          vectorEnabled: false,
          sources: ["sessions"],
          sessionMemory: true,
        }),
        "default",
      );
      const active = createDeferred<void>();
      let pending: Promise<void> | undefined;
      let sync: MockInstance<MemoryIndexManager["sync"]> | undefined;
      try {
        await manager.sync({ reason: "rollover-baseline", force: true });
        await fixture.seedSessionTranscript({
          sessionId: "rollover-previous",
          sessionKey,
          messages: [{ role: "user", content: "Active pass alpha change.", timestamp: 2 }],
        });
        provider.providerRuntimeBatchGate = active.promise;
        pending = manager.sync({
          reason: "rollover-active",
          ...(scope === "targeted"
            ? { sessions: [{ agentId: "main", sessionId: "rollover-previous", sessionKey }] }
            : { force: true }),
        });
        await vi.waitFor(() => expect(provider.providerRuntimeActiveBatchCalls).toBe(1));
        sync = vi.spyOn(manager, "sync");
        await fixture.seedSessionTranscript({
          sessionId: "rollover-replacement",
          sessionKey,
          messages: [{ role: "user", content: "Replacement generation beta.", timestamp: 3 }],
        });
        // Observe the real listener debounce while the old generation still owns sync.
        await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1), { timeout: 8000 });
        active.resolve();
        await pending;
        await Promise.all(sync.mock.results.map((result) => result.value));

        const db = Reflect.get(manager, "db") as DatabaseSync;
        expect(
          db
            .prepare(
              "SELECT path FROM memory_index_sources WHERE source = 'sessions' ORDER BY path",
            )
            .all(),
        ).toEqual([{ path: "sessions/main/rollover-replacement.jsonl" }]);
        expect(manager.status().dirty).toBe(false);
        expect(provider.providerRuntimeMaxActiveBatchCalls).toBe(1);
      } finally {
        active.resolve();
        provider.providerRuntimeBatchGate = null;
        await pending;
        await Promise.allSettled(sync?.mock.results.map((result) => result.value) ?? []);
        sync?.mockRestore();
        await manager.close();
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "win32").each([
    { label: "normal", resetDirty: false },
    { label: "dirty reset before debounce", resetDirty: true },
  ])(
    "automatically indexes an ordinary edit through the real native watcher ($label)",
    async ({ resetDirty }) => {
      const nativeFactoryKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
      const originalNativeFactory = Object.getOwnPropertyDescriptor(globalThis, nativeFactoryKey);
      // This fixture normally suppresses OS events. These two cases exercise the real watcher.
      Reflect.deleteProperty(globalThis, nativeFactoryKey);
      const nativeWatch = vi.spyOn(fsSync, "watch");
      let manager: MemoryIndexManager | undefined;
      let sync: MockInstance<MemoryIndexManager["sync"]> | undefined;
      let memoryWatcher: fsSync.FSWatcher | undefined;
      let onNativeChange: fsSync.WatchListener<string | Buffer> | undefined;
      try {
        expect(Reflect.get(globalThis, nativeFactoryKey)).toBeUndefined();
        manager = await getFreshManager(
          createConfig({
            provider: "batch-test",
            fallback: "none",
            vectorEnabled: false,
            sources: ["memory"],
          }),
          "default",
        );
        nativeWatch.mock.calls.forEach(([dir]) => {
          expect(String(dir).startsWith(fixture.paths.root)).toBe(true);
        });
        expect(nativeWatch).toHaveBeenCalledWith(
          fixture.paths.memory,
          { recursive: true },
          expect.any(Function),
        );
        const watcherResult =
          nativeWatch.mock.results[
            nativeWatch.mock.calls.findIndex(([dir]) => dir === fixture.paths.memory)
          ];
        if (watcherResult?.type !== "return") {
          throw new Error("Native memory directory watcher missing");
        }
        memoryWatcher = watcherResult.value;
        await manager.sync({ reason: "real-watch-baseline", force: true });
        expect(manager.status().dirty).toBe(false);
        const activeManager = manager;
        const readText = () => {
          const db = Reflect.get(activeManager, "db") as DatabaseSync;
          expect(db.isOpen).toBe(true);
          return db
            .prepare(
              "SELECT text FROM memory_index_chunks WHERE source = 'memory' AND path = ? ORDER BY start_line",
            )
            .all("memory/2026-01-12.md");
        };
        expect(readText()).toEqual([{ text: "# Log\nAlpha memory line.\nZebra memory line." }]);
        const watchSync = vi.spyOn(manager, "sync");
        sync = watchSync;
        const nativeEvents: Array<{ dirty: boolean; syncCalls: number }> = [];
        onNativeChange = (_eventType, filename) => {
          if (filename !== null && filename.toString() !== "2026-01-12.md") {
            return;
          }
          nativeEvents.push({
            dirty: Reflect.get(activeManager, "dirty") === true,
            syncCalls: watchSync.mock.calls.length,
          });
          if (resetDirty) {
            // Repeat for duplicate OS notifications so they cannot hide the race.
            Reflect.set(activeManager, "dirty", false);
          }
        };
        // Registered after the production callback: its dirty mark and timer already exist.
        memoryWatcher.on("change", onNativeChange);

        // The single-chunk path preserves the final LF, unlike the baseline input.
        const changed = "# Log\nAlpha ordinary native watcher marker.\n";
        await fs.writeFile(path.join(fixture.paths.memory, "2026-01-12.md"), changed);
        await vi.waitFor(() => expect(nativeEvents[0]).toEqual({ dirty: true, syncCalls: 0 }));

        // No sync/search call after the edit; neither spy replaces real behavior.
        await vi.waitFor(
          () => {
            expect(sync).toHaveBeenCalledWith({ reason: "watch" });
            expect(readText()).toEqual([{ text: changed }]);
            expect(manager?.status().dirty).toBe(false);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        if (onNativeChange) {
          memoryWatcher?.off("change", onNativeChange);
        }
        await manager?.close();
        sync?.mockRestore();
        nativeWatch.mockRestore();
        if (originalNativeFactory) {
          Object.defineProperty(globalThis, nativeFactoryKey, originalNativeFactory);
        }
      }
    },
    20_000,
  );
});
