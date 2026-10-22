/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  admitObservationRoot,
  watch,
  type WatchOptions,
  type WatchSubscription,
} from "openclaw/plugin-sdk/file-access-runtime";
import type {
  OpenClawPluginServiceV2,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  createCodexDesktopGenerationOwner,
  type CodexDesktopGeneration,
} from "./desktop-generation-owner.js";

const APPLICATIONS_PATH = "/Applications";
const REARM_INITIAL_DELAY_MS = 100;
const REARM_MAX_DELAY_MS = 30_000;

type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type WatchFactory = (watchedPath: string, options: WatchOptions) => Promise<WatchSubscription>;
type DesktopGenerationRuntime = {
  platform: NodeJS.Platform;
  readFingerprint: () => Promise<string>;
  resolveWatchPaths: () => string[];
  pathExists: (watchedPath: string) => boolean;
  watchPath: WatchFactory;
};
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  watchers?: Set<WatchSubscription>;
  watcherAdmission?: Promise<boolean>;
  watcherRetirement?: Promise<void>;
  watchHealthy?: boolean;
  rearmPending?: boolean;
  rearmDelayMs?: number;
  context?: OpenClawPluginServiceContextV2;
  runtime?: DesktopGenerationRuntime;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  return state().owner?.wait() ?? Promise.resolve(undefined);
}

export function isCodexDesktopGenerationCurrent(
  generation: CodexDesktopGeneration | undefined,
): boolean {
  return state().owner?.isCurrent(generation) ?? false;
}

export function createCodexDesktopGenerationService(
  params: {
    onGenerationChange: (generation: CodexDesktopGeneration) => void;
  },
  runtime: DesktopGenerationRuntime = {
    platform: process.platform,
    readFingerprint: readMacOSDesktopGenerationFingerprint,
    resolveWatchPaths: resolveMacOSDesktopGenerationWatchPaths,
    pathExists: existsSync,
    watchPath: async (watchedPath, options) => {
      const canonical = await realpath(watchedPath);
      const authority = await admitObservationRoot(canonical);
      const relative = path.relative(authority.rootDir, canonical);
      return watch(authority, {
        ...options,
        scopes: options.scopes.map((scope) => ({
          ...scope,
          path: path.join(relative, scope.path),
        })),
      });
    },
  },
): OpenClawPluginServiceV2 {
  return {
    apiVersion: 2,
    id: "codex-desktop-generation",
    async start(ctx) {
      if (runtime.platform !== "darwin") {
        return;
      }
      const current = state();
      await current.watcherRetirement;
      current.context = ctx;
      current.runtime = { ...runtime };
      const owner = createCodexDesktopGenerationOwner({
        signal: ctx.scheduler.signal,
        readFingerprint: runtime.readFingerprint,
        onGenerationChange: params.onGenerationChange,
        initialGeneration: current.lastGeneration,
      });
      current.owner = owner;
      owner.markDirty();
      await armWatchers(current);
      if (isCurrentOwner(current, owner)) {
        void refreshGeneration(current, owner, owner.refresh());
      }
    },
    async stop() {
      const current = state();
      const owner = current.owner;
      const scheduler = current.context?.scheduler;
      scheduler?.beginClose();
      current.lastGeneration = current.owner?.read() ?? current.lastGeneration;
      current.owner = undefined;
      current.context = undefined;
      current.runtime = undefined;
      current.watchHealthy = undefined;
      current.rearmDelayMs = undefined;
      current.rearmPending = false;
      await joinRetirement([closeWatchers(current), scheduler?.stop(), owner?.waitForIdle()]);
    },
  };
}

function armWatchers(current: DesktopGenerationState): Promise<boolean> {
  const owner = current.owner;
  const runtime = current.runtime;
  if (!owner || !runtime || current.watchers) {
    return Promise.resolve(false);
  }
  const watchers = new Set<WatchSubscription>();
  current.watchers = watchers;
  const candidateNames = new Set(
    resolveMacOSDesktopCodexAppPathCandidates("darwin").map((candidate) => candidate.appName),
  );
  const admission = Promise.resolve().then(async () => {
    let complete = true;
    for (const watchedPath of runtime.resolveWatchPaths()) {
      if (!isCurrentArm(current, owner, watchers)) {
        return false;
      }
      if (!runtime.pathExists(watchedPath)) {
        continue;
      }
      let watcher: WatchSubscription;
      let ready = false;
      try {
        watcher = await runtime.watchPath(watchedPath, {
          // The native observer avoids Node's synchronous FSEvents unregister on macOS.
          // Bundle trees retain nested Computer Use invalidation without scanning other apps.
          scopes:
            watchedPath === APPLICATIONS_PATH
              ? [...candidateNames].map((name) => ({ path: name, kind: "entry" }))
              : [{ path: ".", kind: "tree", depth: 128 }],
          mode: "events",
          onInvalidate: () => {
            // Initial admission publishes a reconcile invalidation; rearming it would loop.
            if (!ready || !isCurrentArm(current, owner, watchers)) {
              return;
            }
            owner.markDirty();
            scheduleRearm(current, owner);
          },
          onHealth: (health) => {
            if (!isCurrentArm(current, owner, watchers) || health.state !== "unavailable") {
              return;
            }
            complete = false;
            reportWatcherFailure(
              current,
              owner,
              health.failure?.error ?? new Error("Desktop watch unavailable"),
            );
            scheduleRearm(current, owner);
          },
        });
      } catch (error) {
        if (isCurrentArm(current, owner, watchers)) {
          complete = false;
          reportWatcherFailure(current, owner, error);
          scheduleRearm(current, owner);
        }
        continue;
      }
      watchers.add(watcher);
      if (!isCurrentArm(current, owner, watchers)) {
        await watcher.close();
        return false;
      }
      try {
        await watcher.ready;
        ready = true;
        if (isCurrentArm(current, owner, watchers)) {
          owner.markDirty();
        }
      } catch (error) {
        if (isCurrentArm(current, owner, watchers)) {
          complete = false;
          reportWatcherFailure(current, owner, error);
          scheduleRearm(current, owner);
        }
      }
    }
    if (!isCurrentArm(current, owner, watchers)) {
      return false;
    }
    current.watchHealthy = complete;
    if (complete) {
      current.rearmDelayMs = REARM_INITIAL_DELAY_MS;
    }
    return complete;
  });
  current.watcherAdmission = admission;
  return admission;
}

function reportWatcherFailure(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  error: unknown,
): void {
  if (current.watchHealthy === false) {
    return;
  }
  current.watchHealthy = false;
  owner.markDirty();
  current.context?.serviceHealth?.reportFailure(error);
  current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
}

function isCurrentArm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  watchers: Set<WatchSubscription>,
): boolean {
  return isCurrentOwner(current, owner) && current.watchers === watchers;
}

function scheduleRearm(current: DesktopGenerationState, owner: GenerationOwner): void {
  if (current.rearmPending && current.watchHealthy === false) {
    return;
  }
  const delayMs =
    current.watchHealthy === false
      ? (current.rearmDelayMs ?? REARM_INITIAL_DELAY_MS)
      : REARM_INITIAL_DELAY_MS;
  if (current.watchHealthy === false) {
    current.rearmDelayMs = Math.min(delayMs * 2, REARM_MAX_DELAY_MS);
  }
  current.rearmPending = true;
  current.context?.scheduler.schedule({
    id: "watcher-rearm",
    delayMs,
    run: async () => {
      current.rearmPending = false;
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      const wasUnhealthy = current.watchHealthy === false;
      try {
        await closeWatchers(current);
      } catch (error) {
        if (isCurrentOwner(current, owner)) {
          reportWatcherFailure(current, owner, error);
        }
        return;
      }
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      const healthy = await armWatchers(current);
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      if (!healthy || wasUnhealthy) {
        owner.markDirty();
      }
      await refreshGeneration(current, owner, owner.wait());
    },
  });
}

function refreshGeneration(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): Promise<void> {
  return refresh
    .then(() => {
      if (isCurrentOwner(current, owner) && current.watchHealthy) {
        current.context?.serviceHealth?.clearFailure();
      }
    })
    .catch((error: unknown) => {
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      current.context?.serviceHealth?.reportFailure(error);
      current.context?.logger.warn(`codex desktop generation refresh failed: ${String(error)}`);
    });
}

function closeWatchers(current: DesktopGenerationState): Promise<void> {
  const watchers = current.watchers;
  const admission = current.watcherAdmission;
  if (!watchers && !admission) {
    return current.watcherRetirement ?? Promise.resolve();
  }
  current.watchers = undefined;
  current.watcherAdmission = undefined;
  // Fence callbacks before retirement; an in-flight admission closes its own late handle.
  const retirement = joinRetirement([
    current.watcherRetirement,
    ...Array.from(watchers ?? [], async (watcher) => watcher.close()),
    admission,
  ]);
  current.watcherRetirement = retirement;
  void retirement.then(
    () => {
      if (current.watcherRetirement === retirement) {
        current.watcherRetirement = undefined;
      }
    },
    () => {}, // Failed native retirement blocks replacement and remains visible to service stop.
  );
  return retirement;
}

async function joinRetirement(work: (Promise<unknown> | undefined)[]): Promise<void> {
  const settled = await Promise.allSettled(work.filter((pending) => pending !== undefined));
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Codex desktop generation retirement failed");
  }
}

function isCurrentOwner(current: DesktopGenerationState, owner: GenerationOwner): boolean {
  return current.owner === owner && !current.context?.scheduler.signal.aborted;
}
