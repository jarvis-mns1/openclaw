import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { createGitBackup } from "./git-backup.js";

const [root, repositoryPath, scope] = process.argv.slice(2);
if (!root || !repositoryPath || (scope !== "global" && scope !== "agent")) {
  throw new Error("Expected fixture root, repository, and global/agent scope");
}

// Observe real filesystem contention so the parent can release its Git hook
// without relying on a sleep or a production-only test seam.
__setFsSafeTestHooksForTest({
  beforeSidecarLockSnapshotOpen(lockPath) {
    if (lockPath.endsWith("openclaw-git-backup.lock")) {
      process.send?.("lock-contended");
    }
  },
});

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort(new Error("test child cancelled")));
try {
  const result = await withCommandProcessScope(
    () =>
      createGitBackup({
        repositoryPath,
        stateDir: path.join(root, "state"),
        databases: [
          scope === "global"
            ? { path: path.join(root, "global.sqlite"), identity: { role: "global" } }
            : {
                path: path.join(root, "agent.sqlite"),
                identity: { role: "agent", agentId: "fixture" },
              },
        ],
        excludeSecrets: true,
        push: true,
      }),
    controller.signal,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  __setFsSafeTestHooksForTest(undefined);
  process.disconnect?.();
}
