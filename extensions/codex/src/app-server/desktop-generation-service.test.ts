import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WatchOptions, WatchSubscription } from "openclaw/plugin-sdk/file-access-runtime";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexBuildSymbol } from "../build-state.js";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

class FakeWatcher implements WatchSubscription {
  ready = Promise.resolve();
  close = vi.fn(async () => {});
  setScopes = vi.fn(async () => {});
  reconcile = vi.fn(async () => {});
  health = vi.fn(() => ({ state: "ready" as const, mode: "events" as const, directories: 1 }));
  [Symbol.asyncDispose] = () => this.close();
}

type WatchRegistration = {
  watchedPath: string;
  options: WatchOptions;
  watcher: FakeWatcher;
};

function createServiceContext(
  warn: OpenClawPluginServiceContextV2["logger"]["warn"],
  serviceHealth: NonNullable<OpenClawPluginServiceContextV2["serviceHealth"]>,
): OpenClawPluginServiceContextV2 {
  return {
    config: {},
    stateDir: "/unused",
    scheduler: createTestPluginServiceScheduler(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    serviceHealth,
  };
}

function createHarness(initialFingerprint: string, initialWatchFailures = 0) {
  let watchFailures = initialWatchFailures;
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  let watchAttempts = 0;
  const context = createServiceContext(warn, { clearFailure, reportFailure });
  const watchPath = vi.fn(async (watchedPath: string, options: WatchOptions) => {
    watchAttempts += 1;
    if (watchFailures > 0) {
      watchFailures -= 1;
      throw new Error("watch registration unavailable");
    }
    const watcher = new FakeWatcher();
    watcher.ready = Promise.resolve().then(() => options.onInvalidate({ reason: "reconcile" }));
    registrations.push({ watchedPath, options, watcher });
    return watcher;
  });
  const service = createCodexDesktopGenerationService(
    { onGenerationChange },
    {
      platform: "darwin",
      readFingerprint,
      resolveWatchPaths: () => ["/Applications", "/Applications/ChatGPT.app"],
      pathExists: () => true,
      watchPath,
    },
  );
  return {
    service,
    context,
    registrations,
    watchPath,
    readFingerprint,
    onGenerationChange,
    clearFailure,
    reportFailure,
    warn,
    get watchAttempts() {
      return watchAttempts;
    },
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start(harness.context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(harness.readFingerprint).toHaveBeenCalledOnce();
}

describe("Codex desktop generation service", () => {
  let current:
    | {
        service: ReturnType<typeof createCodexDesktopGenerationService>;
        context: OpenClawPluginServiceContextV2;
      }
    | undefined;

  afterEach(async () => {
    if (current) {
      await current.service.stop?.(current.context);
    }
    current = undefined;
    // Each case owns a fresh lifetime, including terminal retirement failures.
    Reflect.deleteProperty(globalThis, codexBuildSymbol("openclaw.codexDesktopGenerationState"));
    vi.useRealTimers();
  });

  it.each([1, Infinity])(
    "retries failed watch registration once (%s failures)",
    async (failures) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-rearm", failures);
      current = harness;
      await harness.service.start(harness.context);
      expect(harness.watchAttempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(harness.watchAttempts).toBe(4);
      expect(harness.registrations).toHaveLength(failures === 1 ? 3 : 0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.watchAttempts).toBe(4);
      if (failures === Infinity) {
        harness.setFingerprint("updated-without-watcher");
        const next = waitForCodexDesktopGeneration();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await next).toMatchObject({ fingerprint: "updated-without-watcher" });
        expect(harness.watchAttempts).toBe(4);
      }
    },
  );

  it("rearms stable directory watches and publishes a settled root replacement", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-x");
    current = harness;
    await startAndSettle(harness);
    harness.onGenerationChange.mockClear();
    harness.clearFailure.mockClear();
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");
    expect(applications).toBeDefined();

    harness.setFingerprint("desktop-y");
    applications?.options.onInvalidate({ reason: "event" });
    await vi.advanceTimersByTimeAsync(100);
    expect(oldArm.every((entry) => entry.watcher.close.mock.calls.length === 1)).toBe(true);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.onGenerationChange).toHaveBeenCalledOnce());
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-y",
    });
    applications?.options.onInvalidate({ reason: "event" });
    oldArm[0]?.options.onHealth?.({ state: "unavailable", mode: "events", directories: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("scopes observation to desktop candidates and recovers a watcher error", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-errors");
    current = harness;
    await startAndSettle(harness);
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");

    expect(applications?.options.scopes).toEqual([
      { path: "ChatGPT.app", kind: "entry" },
      { path: "Codex.app", kind: "entry" },
    ]);
    expect(oldArm[1]?.options.scopes).toEqual([{ path: ".", kind: "tree", depth: 128 }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(2);

    oldArm[0]?.options.onHealth?.({
      state: "unavailable",
      mode: "events",
      directories: 0,
      failure: { operation: "watch", error: new Error("watch lost") },
    });
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.clearFailure).toHaveBeenCalledTimes(2));
  });

  it("does not publish a generation after service stop during settling", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    current = harness;
    await harness.service.start(harness.context);

    await harness.service.stop?.(harness.context);
    current = undefined;
    expect(vi.getTimerCount()).toBe(0);
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).not.toHaveBeenCalled();
  });

  it.each(["change", "error"])(
    "ignores watcher %s callbacks after scheduler admission closes",
    async (event) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-closing");
      current = harness;
      await startAndSettle(harness);
      harness.context.scheduler.beginClose();

      const registration = harness.registrations[0]!;
      expect(() => {
        if (event === "change") {
          registration.options.onInvalidate({ reason: "event" });
        } else {
          registration.options.onHealth?.({
            state: "unavailable",
            mode: "events",
            directories: 0,
          });
        }
      }).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.watchAttempts).toBe(2);
      expect(harness.readFingerprint).toHaveBeenCalledOnce();
      expect(harness.reportFailure).not.toHaveBeenCalled();
    },
  );

  it("joins an admitted fingerprint read before service retirement completes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-in-flight");
    const read = createDeferred<string>();
    harness.readFingerprint.mockImplementationOnce(() => read.promise);
    current = harness;
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.readFingerprint).toHaveBeenCalledOnce();

    const retired = vi.fn();
    const stopping = Promise.resolve(harness.service.stop?.(harness.context)).then(retired);
    try {
      await Promise.resolve();
      expect(retired).not.toHaveBeenCalled();
      expect(
        harness.registrations.every(({ watcher }) => watcher.close.mock.calls.length === 1),
      ).toBe(true);
    } finally {
      read.resolve("desktop-after-stop");
      await stopping;
    }
    current = undefined;
    expect(retired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each(["stop", "rearm"])(
    "joins every watcher retirement started by %s before service stop completes",
    async (trigger) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-watch-retirement");
      current = harness;
      await startAndSettle(harness);
      const closed = createDeferred<void>();
      harness.registrations[0]!.watcher.close.mockImplementation(() => closed.promise);
      if (trigger === "rearm") {
        harness.registrations[0]!.options.onInvalidate({ reason: "event" });
        await vi.advanceTimersByTimeAsync(100);
      }
      const retired = vi.fn();
      const stopping = Promise.resolve(harness.service.stop?.(harness.context)).then(retired);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(retired).not.toHaveBeenCalled();
        expect(
          harness.registrations.every(({ watcher }) => watcher.close.mock.calls.length === 1),
        ).toBe(true);
      } finally {
        closed.resolve();
        await stopping;
      }
      current = undefined;
      expect(retired).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.registrations).toHaveLength(2);
      expect(harness.onGenerationChange).not.toHaveBeenCalled();
    },
  );

  it("retires a watcher admitted after stop without publishing or rearming", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-late-admission");
    const admitted = createDeferred<FakeWatcher>();
    const closed = createDeferred<void>();
    const watcher = new FakeWatcher();
    watcher.close.mockImplementation(() => closed.promise);
    harness.watchPath.mockImplementationOnce(() => admitted.promise);
    current = harness;
    const starting = Promise.resolve(harness.service.start(harness.context));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.watchPath).toHaveBeenCalledOnce();
    const retired = vi.fn();
    const stopping = Promise.resolve(harness.service.stop?.(harness.context)).then(retired);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(retired).not.toHaveBeenCalled();
      admitted.resolve(watcher);
      await vi.advanceTimersByTimeAsync(0);
      expect(watcher.close).toHaveBeenCalledOnce();
      expect(retired).not.toHaveBeenCalled();
      harness.watchPath.mock.calls[0]?.[1].onInvalidate({ reason: "event" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.watchPath).toHaveBeenCalledOnce();
      expect(harness.readFingerprint).not.toHaveBeenCalled();
      expect(harness.onGenerationChange).not.toHaveBeenCalled();
    } finally {
      admitted.resolve(watcher);
      closed.resolve();
      await Promise.all([starting, stopping]);
    }
    current = undefined;
    expect(retired).toHaveBeenCalledOnce();
  });

  it("closes an admitted watcher while readiness is pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-pending-ready");
    const ready = createDeferred<void>();
    const watcher = new FakeWatcher();
    watcher.ready = ready.promise;
    watcher.close.mockImplementation(async () => ready.reject(new Error("watch closed")));
    harness.watchPath.mockResolvedValueOnce(watcher);
    current = harness;
    const starting = Promise.resolve(harness.service.start(harness.context));
    await vi.advanceTimersByTimeAsync(0);
    await harness.service.stop?.(harness.context);
    await starting;
    current = undefined;
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(harness.watchPath).toHaveBeenCalledOnce();
    expect(harness.readFingerprint).not.toHaveBeenCalled();
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("joins sibling retirements and fingerprint reads before reporting a close failure", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-close-failure");
    const read = createDeferred<string>();
    harness.readFingerprint.mockImplementationOnce(() => read.promise);
    current = harness;
    await startAndSettle(harness);
    const closed = createDeferred<void>();
    harness.registrations[0]!.watcher.close.mockRejectedValue(new Error("close failed"));
    harness.registrations[1]!.watcher.close.mockImplementation(() => closed.promise);
    const rejected = vi.fn();
    const stopping = Promise.resolve(harness.service.stop?.(harness.context)).catch(rejected);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(rejected).not.toHaveBeenCalled();
      closed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      closed.resolve();
      read.resolve("desktop-after-stop");
      await stopping;
    }
    current = undefined;
    expect(rejected).toHaveBeenCalledWith(expect.any(AggregateError));
    expect(harness.onGenerationChange).not.toHaveBeenCalled();
  });

  it("reports and retains a failed rearm retirement without admitting replacements", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-rearm-close-failure");
    current = harness;
    await startAndSettle(harness);
    harness.registrations[0]!.watcher.close.mockRejectedValue(new Error("rearm close failed"));
    harness.registrations[0]!.options.onInvalidate({ reason: "event" });
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.reportFailure).toHaveBeenCalledWith(expect.any(AggregateError));
    expect(harness.registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.registrations).toHaveLength(2);
    await expect(harness.service.stop?.(harness.context)).rejects.toThrow(
      "Codex desktop generation retirement failed",
    );
    current = undefined;
    await expect(harness.service.start(harness.context)).rejects.toThrow(
      "Codex desktop generation retirement failed",
    );
  });
});
