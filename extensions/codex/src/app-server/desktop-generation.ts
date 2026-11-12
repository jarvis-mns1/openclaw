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
  context?: OpenClawPluginServiceContextV2;
  runtime?: DesktopGenerationRuntime;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  const current = state();
  const owner = current.owner;
  return (
    (current.watchHealthy === false ? owner?.refresh() : owner?.wait()) ??
    Promise.resolve(undefined)
  );
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
      await joinRetirement([closeWatchers(current), scheduler?.stop(), owner?.waitForIdle()]);
    },
  };
}

function armWatchers(current: DesktopGenerationState, retryOnFailure = true): Promise<boolean> {
  const owner = current.owner;
  const runtime = current.runtime;
  if (!owner || !runtime || current.watchers) {
    return Promise.resolve(false);
  }
  const watchers = new Set<WatchSubscription>();
  current.watchers = watchers;
  const candidateNames = new Set<string>(
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
          // Native subscriptions avoid main-process Node FSEvents close. Bound bundle
          // scans while preserving nested Computer Use artifact invalidation.
          scopes:
            watchedPath === APPLICATIONS_PATH
              ? [...candidateNames].map((name) => ({ path: name, kind: "entry" }))
              : [{ path: ".", kind: "tree", depth: 128 }],
          mode: "events",
          onInvalidate: () => {
            // Admission's reconcile invalidation must not start a rearm loop.
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
            if (ready || retryOnFailure) {
              scheduleRearm(current, owner, false);
            }
          },
        });
      } catch (error) {
        if (isCurrentArm(current, owner, watchers)) {
          complete = false;
          reportWatcherFailure(current, owner, error);
        }
        continue;
      }
      watchers.add(watcher);
      if (!isCurrentArm(current, owner, watchers)) {
        // Retirement already captured the admitted handles; join this late one here.
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
        }
      }
    }
    if (!isCurrentArm(current, owner, watchers)) {
      return false;
    }
    current.watchHealthy = complete;
    if (!complete && retryOnFailure) {
      scheduleRearm(current, owner, false);
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
  if (!isCurrentOwner(current, owner) || current.watchHealthy === false) {
    return;
  }
  current.watchHealthy = false;
  owner.markDirty();
  current.context?.serviceHealth?.reportFailure(error);
  current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
}

function isCurrentOwner(current: DesktopGenerationState, owner: GenerationOwner): boolean {
  return current.owner === owner && current.context?.scheduler.signal.aborted === false;
}

function isCurrentArm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  watchers: Set<WatchSubscription>,
): boolean {
  return isCurrentOwner(current, owner) && current.watchers === watchers;
}

function scheduleRearm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  retryOnFailure = true,
): void {
  if (!isCurrentOwner(current, owner)) {
    return;
  }
  current.context?.scheduler.schedule({
    id: "watcher-rearm",
    delayMs: REARM_INITIAL_DELAY_MS,
    run: async () => {
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      const wasUnhealthy = current.watchHealthy === false;
      try {
        await closeWatchers(current);
      } catch (error) {
        reportWatcherFailure(current, owner, error);
        return;
      }
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      const healthy = await armWatchers(current, retryOnFailure);
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
  // Fence callbacks first. All handles and admitted work settle even if one close fails.
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
    () => {}, // Preserve failed retirement for stop and prohibit replacement watchers.
  );
  return retirement;
}

async function joinRetirement(work: (Promise<unknown> | undefined)[]): Promise<void> {
  const pending = work.filter((item): item is Promise<unknown> => item !== undefined);
  const settled = await Promise.allSettled(pending);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Codex desktop generation retirement failed");
  }
}
