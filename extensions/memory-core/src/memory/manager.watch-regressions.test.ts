import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveMemorySearchSyncConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";
import { createMemoryWatcherTestFactories } from "./watcher-test-support.js";

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
      const entered = createDeferred<void>();
      const pending: Promise<void>[] = [];
      try {
        await manager.sync({ reason: "watch-race-baseline", force: true });
        await fs.writeFile(
          path.join(fixture.paths.memory, "2026-01-12.md"),
          "# Log\nAlpha memory line changed while indexing.\n",
        );
        markMemoryDirty(manager);
        provider.providerRuntimeBatchGate = gate.promise;
        provider.providerRuntimeBatchEntered = () => entered.resolve();
        pending.push(manager.sync({ reason: "watch-race-active" }));
        await entered.promise;

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

  it.each(["watch", "session-reconcile"])(
    "retries %s admission when a queued session sync takes the slot",
    async (reason) => {
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
      const activeEntered = createDeferred<void>();
      const sessionEntered = createDeferred<void>();
      const owner = manager as unknown as {
        runSync: (params?: MemorySyncParams) => Promise<void>;
      };
      const runSync = vi
        .spyOn(owner, "runSync")
        .mockImplementationOnce(() => {
          activeEntered.resolve();
          return active.promise;
        })
        .mockImplementationOnce(() => {
          sessionEntered.resolve();
          return session.promise;
        });
      const pending: Promise<void>[] = [];
      try {
        pending.push(manager.sync({ reason: "watch-admission-active" }));
        await activeEntered.promise;
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
          manager.sync({ reason }),
        );

        active.resolve();
        await sessionEntered.promise;
        expect(runSync.mock.calls[1]?.[0]?.reason).toBe("queued-sessions");
        session.resolve();
        await Promise.all(pending);
        expect(runSync.mock.calls.map(([params]) => params?.reason)).toContain(reason);
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
    },
  );

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
      const entered = createDeferred<void>();
      const owner = manager as unknown as {
        runSync: (params?: MemorySyncParams) => Promise<void>;
      };
      const runSync = vi.spyOn(owner, "runSync").mockImplementationOnce(() => {
        entered.resolve();
        return active.promise;
      });
      const pending: Promise<void>[] = [];
      try {
        pending.push(manager.sync({ reason: "mixed-watch-active" }));
        await entered.promise;
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
    const activeEntered = createDeferred<void>();
    const followUpEntered = createDeferred<void>();
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
      provider.providerRuntimeBatchEntered = () => activeEntered.resolve();
      pending.push(manager.sync({ reason: "watch-follow-up-active" }));
      await activeEntered.promise;

      await fs.writeFile(
        path.join(fixture.paths.memory, "first-follow-up.md"),
        "# Log\nFirst follow-up marker.\n",
      );
      markMemoryDirty(manager);
      const firstFollowUp = manager.sync({ reason: "watch" });
      pending.push(firstFollowUp);
      provider.providerRuntimeBatchGate = followUp.promise;
      provider.providerRuntimeBatchEntered = () => followUpEntered.resolve();
      active.resolve();
      expect(
        await Promise.race([
          followUpEntered.promise.then(() => true),
          firstFollowUp.then(() => false),
        ]),
      ).toBe(true);
      expect(provider.providerRuntimeBatchCalls).toHaveLength(baselineCalls + 1);
      expect(provider.providerRuntimeActiveBatchCalls).toBe(1);

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
    const entered = createDeferred<void>();
    const failure = new Error("watch indexing failed");
    const owner = manager as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSync = vi.spyOn(owner, "runSync").mockImplementationOnce(() => {
      entered.resolve();
      return active.promise;
    });
    const pending: Promise<void>[] = [];
    try {
      pending.push(manager.sync({ reason: "watch" }));
      await entered.promise;
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
    const entered = createDeferred<void>();
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
      provider.providerRuntimeBatchEntered = () => entered.resolve();
      pending.push(manager.sync({ reason: "watch-close-active" }));
      await entered.promise;
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
      const entered = createDeferred<void>();
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
        provider.providerRuntimeBatchEntered = () => entered.resolve();
        pending = manager.sync({
          reason: "rollover-active",
          ...(scope === "targeted"
            ? { sessions: [{ agentId: "main", sessionId: "rollover-previous", sessionKey }] }
            : { force: true }),
        });
        await entered.promise;
        sync = vi.spyOn(manager, "sync");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await fixture.seedSessionTranscript({
          sessionId: "rollover-replacement",
          sessionKey,
          messages: [{ role: "user", content: "Replacement generation beta.", timestamp: 3 }],
        });
        // Advance the production listener debounce while the old generation owns sync.
        await vi.advanceTimersByTimeAsync(5000);
        vi.useRealTimers();
        expect(sync).toHaveBeenCalledWith({ reason: "session-reconcile" });
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
        vi.useRealTimers();
        active.resolve();
        provider.providerRuntimeBatchGate = null;
        await pending;
        await Promise.allSettled(sync?.mock.results.map((result) => result.value) ?? []);
        sync?.mockRestore();
        await manager.close();
      }
    },
  );

  it.each([
    { label: "normal", resetDirty: false },
    { label: "dirty reset before debounce", resetDirty: true },
  ])(
    "automatically indexes an ordinary edit through the native watcher callback ($label)",
    async ({ resetDirty }) => {
      const factoryKeys = [
        Symbol.for("openclaw.test.memoryWatchFactory"),
        Symbol.for("openclaw.test.memoryNativeWatchFactory"),
      ];
      const originalFactories = factoryKeys.map((key) =>
        Object.getOwnPropertyDescriptor(globalThis, key),
      );
      const watchers = createMemoryWatcherTestFactories();
      let manager: MemoryIndexManager | undefined;
      let sync: MockInstance<MemoryIndexManager["sync"]> | undefined;
      try {
        const config = createConfig({
          provider: "batch-test",
          fallback: "none",
          vectorEnabled: false,
          sources: ["memory"],
        });
        const syncSettings = resolveMemorySearchSyncConfig(config, "main");
        if (!syncSettings) {
          throw new Error("Expected memory sync settings");
        }
        manager = await getFreshManager(config, "default");
        await manager.sync({ reason: "native-watch-baseline", force: true });
        expect(manager.status().dirty).toBe(false);
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const readText = () =>
          db
            .prepare(
              "SELECT text FROM memory_index_chunks WHERE source = 'memory' AND path = ? ORDER BY start_line",
            )
            .all("memory/2026-01-12.md");
        expect(readText()).toEqual([{ text: "# Log\nAlpha memory line.\nZebra memory line." }]);

        sync = vi.spyOn(manager, "sync");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const changed = "# Log\nAlpha ordinary native watcher marker.\n";
        await fs.writeFile(path.join(fixture.paths.memory, "2026-01-12.md"), changed);
        const watcher = watchers.createdNativeWatchers.find(
          (entry) => entry.dir === fixture.paths.memory,
        );
        expect(watcher).toBeDefined();
        watcher?.emit("change", "2026-01-12.md");
        expect(Reflect.get(manager, "dirty")).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        if (resetDirty) {
          Reflect.set(manager, "dirty", false);
        }
        await vi.advanceTimersByTimeAsync(syncSettings.watchDebounceMs);
        vi.useRealTimers();
        expect(sync).toHaveBeenCalledWith({ reason: "watch" });
        await Promise.all(sync.mock.results.map((result) => result.value));
        expect(readText()).toEqual([{ text: changed }]);
        expect(manager.status().dirty).toBe(false);
      } finally {
        vi.useRealTimers();
        await manager?.close();
        sync?.mockRestore();
        factoryKeys.forEach((key, index) => {
          const descriptor = originalFactories[index];
          if (descriptor) {
            Object.defineProperty(globalThis, key, descriptor);
          } else {
            Reflect.deleteProperty(globalThis, key);
          }
        });
      }
    },
  );
});
