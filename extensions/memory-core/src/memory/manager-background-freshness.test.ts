import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory background freshness", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider, createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it("does not let a session-only pass consume an accepted memory watch generation", async () => {
    const sessionId = "session-only";
    await seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", content: "Original alpha session.", timestamp: 1 }],
    });
    const manager = await getFreshManager(
      createConfig({
        provider: "batch-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: ["memory", "sessions"],
        sessionMemory: true,
      }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    await seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", content: "Changed beta session.", timestamp: 2 }],
    });
    await fs.writeFile(
      path.join(fixture.paths.memory, "pending.md"),
      "Memory watch generation must survive the session pass.",
    );
    // Native observation accepts dirtiness before its settled callback requests sync.
    (manager as unknown as { markMemoryWatchDirty(): void }).markMemoryWatchDirty();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    provider.providerRuntimeBatchEntered = () => entered.resolve();
    provider.providerRuntimeBatchGate = resume.promise;
    const pending = [
      manager.sync({ reason: "session-delta", sessions: [{ agentId: "main", sessionId }] }),
    ];
    try {
      await Promise.race([entered.promise, pending[0]]);
      expect(provider.providerRuntimeActiveBatchCalls).toBe(1);
      pending.push(manager.sync({ reason: "watch" }));
      resume.resolve();
      await Promise.all(pending);

      // Read publication without a search that could repair a stranded generation.
      using index = new DatabaseSync(manager.status().dbPath!, { readOnly: true });
      expect(
        index
          .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
          .all("memory/pending.md"),
      ).toEqual([{ text: "Memory watch generation must survive the session pass." }]);
      expect(
        index
          .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
          .all(`sessions/main/${sessionId}.jsonl`)
          .map((row) => row.text)
          .join("\n"),
      ).toContain("Changed beta session.");
      expect(manager.status().dirty).toBe(false);
    } finally {
      resume.resolve();
      provider.providerRuntimeBatchGate = null;
      await Promise.allSettled(pending);
      await manager.close();
    }
  });

  it.each(
    ["targeted", "full"].flatMap((scope) =>
      ["agent:main:memory:replacement", "global"].map((sessionKey) => ({ scope, sessionKey })),
    ),
  )(
    "reconciles a $sessionKey replacement accepted during a $scope pass without a search",
    async ({ scope, sessionKey }) => {
      const cfg = createConfig({
        provider: "batch-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: ["sessions"],
        sessionMemory: true,
      });
      await seedSessionTranscript({
        sessionId: "previous",
        sessionKey,
        messages: [{ role: "user", content: "Previous alpha generation.", timestamp: 1 }],
      });
      const initial = await getFreshManager(cfg, "cli");
      await initial.sync({ reason: "baseline", force: true });
      await initial.close();
      const manager = await getFreshManager(cfg, "default");
      const owner = manager as unknown as { awaitManagerIdle(): Promise<void> };
      // Startup is clean; it must not mask a missing live replacement notification.
      await owner.awaitManagerIdle();
      const sync = vi.spyOn(manager, "sync");
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      let active: Promise<void> | undefined;
      try {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        await seedSessionTranscript({
          sessionId: "previous",
          sessionKey,
          messages: [{ role: "user", content: "In-flight alpha change.", timestamp: 2 }],
        });
        provider.providerRuntimeBatchEntered = () => entered.resolve();
        provider.providerRuntimeBatchGate = resume.promise;
        active = manager.sync({
          reason: "active-before-replacement",
          ...(scope === "targeted"
            ? { sessions: [{ agentId: "main", sessionId: "previous", sessionKey }] }
            : { force: true }),
        });
        await Promise.race([entered.promise, active]);
        expect(provider.providerRuntimeActiveBatchCalls).toBe(1);
        await seedSessionTranscript({
          sessionId: "replacement",
          sessionKey,
          messages: [{ role: "user", content: "Replacement beta generation.", timestamp: 3 }],
        });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(sync).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sync).toHaveBeenCalledWith({ reason: "session-reconcile" });
        resume.resolve();
        await active;
        await owner.awaitManagerIdle();

        using index = new DatabaseSync(manager.status().dbPath!, { readOnly: true });
        expect(
          index
            .prepare(
              "SELECT path FROM memory_index_sources WHERE source = 'sessions' ORDER BY path",
            )
            .all(),
        ).toEqual([{ path: "sessions/main/replacement.jsonl" }]);
        expect(
          index.prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions'").all(),
        ).toEqual([{ text: "User: Replacement beta generation." }]);
        expect(manager.status().dirty).toBe(false);
        expect(provider.providerRuntimeMaxActiveBatchCalls).toBe(1);
      } finally {
        resume.resolve();
        provider.providerRuntimeBatchGate = null;
        await Promise.allSettled([active, ...sync.mock.results.map((result) => result.value)]);
        vi.useRealTimers();
        sync.mockRestore();
        await manager.close();
      }
    },
  );
});
