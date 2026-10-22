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

function createHarness(initialFingerprint: string) {
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  const context = createServiceContext(warn, { clearFailure, reportFailure });
  const watchPath = vi.fn(async (watchedPath: string, options: WatchOptions) => {
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
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start(harness.context);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledTimes(2));
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
    // Each case owns a fresh service lifetime, including its terminal retirement failure.
    Reflect.deleteProperty(globalThis, codexBuildSymbol("openclaw.codexDesktopGenerationState"));
    vi.useRealTimers();
  });

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

  it("ignores unrelated application events and recovers a watcher error", async () => {
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

  it("settles the current generation while persistent watcher registration retries", async () => {
    vi.useFakeTimers();
    let fingerprint = "desktop-stable";
    const readFingerprint = vi.fn(async () => fingerprint);
    const onGenerationChange = vi.fn();
    const clearFailure = vi.fn();
    const reportFailure = vi.fn();
    const warn = vi.fn();
    const watchPath = vi.fn(async () => {
      throw new Error("watch unavailable");
    });
    const service = createCodexDesktopGenerationService(
      { onGenerationChange },
      {
        platform: "darwin",
        readFingerprint,
        resolveWatchPaths: () => ["/Applications"],
        pathExists: () => true,
        watchPath,
      },
    );
    const context = createServiceContext(warn, { clearFailure, reportFailure });
    current = { service, context };
    await service.start(context);
    let settled = false;
    void waitForCodexDesktopGeneration().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
    fingerprint = "desktop-updated";
    await vi.advanceTimersByTimeAsync(60_000);

    expect(watchPath.mock.calls.length).toBeGreaterThan(2);
    expect(watchPath.mock.calls.length).toBeLessThan(20);
    expect(readFingerprint.mock.calls.length).toBeGreaterThan(2);
    expect(onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-updated",
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(clearFailure).not.toHaveBeenCalled();
  });

  it("does not publish a generation after service stop during settling", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    current = harness;
    await harness.service.start(harness.context);
    await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());

    await harness.service.stop?.(harness.context);
    current = undefined;
    expect(vi.getTimerCount()).toBe(0);
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
  });

  it("joins an admitted fingerprint read before service retirement completes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-in-flight");
    const read = createDeferred<string>();
    harness.readFingerprint.mockImplementationOnce(() => read.promise);
    current = harness;
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(0);
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

  it("joins every watcher retirement before service stop completes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-watch-retirement");
    current = harness;
    await startAndSettle(harness);
    const closed = createDeferred<void>();
    harness.registrations[0]!.watcher.close.mockImplementation(() => closed.promise);
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
  });

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
      expect(harness.onGenerationChange).not.toHaveBeenCalled();
    } finally {
      admitted.resolve(watcher);
      closed.resolve();
      await Promise.all([starting, stopping]);
    }
    current = undefined;
    expect(retired).toHaveBeenCalledOnce();
  });

  it("joins sibling retirements before reporting a close failure", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-close-failure");
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
    } finally {
      closed.resolve();
      await stopping;
    }
    current = undefined;
    expect(rejected).toHaveBeenCalledWith(expect.any(AggregateError));
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
