import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createGitBackup,
  initializeGitBackupRepository,
  verifyGitBackupRef,
} from "./git-backup.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = roots.make("git-backup-");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  await fs.mkdir(home);
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  })) {
    vi.stubEnv(key, value);
  }
  const global = {
    path: path.join(root, "global.sqlite"),
    identity: { role: "global" } as const,
  };
  const agent = {
    path: path.join(root, "agent.sqlite"),
    identity: { role: "agent", agentId: "fixture" } as const,
  };
  openOpenClawStateDatabase({ path: global.path });
  openOpenClawAgentDatabase({ agentId: "fixture", path: agent.path });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  for (const database of [global, agent]) {
    using source = new DatabaseSync(database.path);
    source.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT)");
    source.prepare("INSERT INTO payload VALUES (1, ?)").run("old");
  }
  const repositoryPath = path.join(root, "repository");
  const remotePath = path.join(root, "remote.git");
  await requireGit(root, ["init", "--bare", remotePath]);
  await initializeGitBackupRepository({ repositoryPath, stateDir, remote: remotePath });
  const git = (...args: string[]) => requireGit(repositoryPath, args);
  await git("config", "user.name", "Backup fixture");
  await git("config", "user.email", "backup@example.invalid");
  await createGitBackup({
    repositoryPath,
    stateDir,
    databases: [global, agent],
    excludeSecrets: true,
  });
  for (const database of [global, agent]) {
    using source = new DatabaseSync(database.path);
    source.prepare("UPDATE payload SET value = ?").run(`new-${database.identity.role}`);
  }
  return { root, repositoryPath, remotePath, git };
}

function startBackup(
  root: string,
  repositoryPath: string,
  scope: "global" | "agent",
  pathEnv = process.env.PATH,
) {
  const contended = createDeferred();
  const contendedAgain = createDeferred();
  let contentionCount = 0;
  const child = fork(
    fileURLToPath(new URL("./git-backup-concurrency.test-support.ts", import.meta.url)),
    [root, repositoryPath, scope],
    {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: { ...process.env, PATH: pathEnv, OPENCLAW_BACKUP_TEST_SCOPE: scope },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
  child.on("message", (message) => {
    if (message === "lock-contended") {
      contended.resolve();
      if (++contentionCount > 1) {
        contendedAgain.resolve();
      }
    }
  });
  const finished = new Promise<Awaited<ReturnType<typeof createGitBackup>>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Backup child failed (${code ?? signal}): ${stderr}`));
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  });
  void finished.catch(() => undefined);
  return { child, finished, contended: contended.promise, contendedAgain: contendedAgain.promise };
}

it.for(["live", "dead"] as const)(
  "respects an aged %s repository lock owner",
  { timeout: 30_000 },
  async (owner, { signal }) => {
    const { root, repositoryPath, git } = await fixture();
    const lockPath = path.join(repositoryPath, ".git", "openclaw-git-backup.lock");
    let pid = process.pid;
    if (owner === "dead") {
      const exited = spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        {
          encoding: "utf8",
        },
      );
      expect(exited.status).toBe(0);
      pid = Number(exited.stdout);
    }
    const payload = JSON.stringify({ pid, createdAt: "2000-01-01T00:00:00.000Z" });
    await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
    const initialHead = await git("rev-parse", "HEAD");
    const backup = startBackup(root, repositoryPath, "global");
    let released = owner === "dead";
    try {
      if (owner === "live") {
        await withinTest(
          awaitGateBeforeSettlement(backup.contendedAgain, backup.finished, "live lock was stolen"),
          signal,
        );
        expect(await fs.readFile(lockPath, "utf8")).toBe(payload);
        expect(await git("rev-parse", "HEAD")).toBe(initialHead);
        expect(
          await fs.readFile(path.join(repositoryPath, "global/tables/payload.jsonl"), "utf8"),
        ).toBe('{"id":1,"value":"old"}\n');
        released = true;
        await fs.unlink(lockPath);
      }
      const result = await withinTest(backup.finished, signal);
      expect(result).toMatchObject({ noChanges: false, pushed: true });
      expect(await git("show", `${result.commit}:global/tables/payload.jsonl`)).toBe(
        '{"id":1,"value":"new-global"}',
      );
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!released) {
        await fs.rm(lockPath, { force: true });
      }
      if (backup.child.exitCode === null && backup.child.signalCode === null) {
        backup.child.kill("SIGTERM");
      }
      await Promise.allSettled([backup.finished]);
    }
  },
);

it("serializes independent scope writers through push, including a canonical-path alias", async ({
  signal,
}) => {
  const { root, repositoryPath, remotePath, git } = await fixture();
  const alias = path.join(root, "alias");
  await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const extra = "global/operator-notes.txt";
  await fs.writeFile(path.join(repositoryPath, extra), "staged operator data\n");
  await git("add", "--", extra);
  const stagedBlob = await git("rev-parse", `:${extra}`);
  await fs.writeFile(path.join(repositoryPath, extra), "unstaged operator data\n");

  const gates = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const gate = (name: string) => {
    let value = gates.get(name);
    if (!value) {
      value = createDeferred();
      gates.set(name, value);
    }
    return value;
  };
  const sockets = new Map<string, Socket>();
  const released = new Set<string>();
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\git-backup-${randomUUID()}`
      : path.join(root, "gates.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (data: Buffer) => {
      input += data.toString();
      if (!input.endsWith("\n")) {
        return;
      }
      const name = input.trim();
      sockets.set(name, socket);
      gate(name).resolve();
      if (released.has(name)) {
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  const release = (name: string) => {
    released.add(name);
    sockets.get(name)?.end();
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const hook = fileURLToPath(new URL("./git-backup-gate.test-support.cjs", import.meta.url));
  const executable = resolveExecutablePath("git");
  if (!executable) {
    throw new Error("Git is required for the backup concurrency fixture");
  }
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const invocation = [process.execPath, hook, pipe, executable];
  await fs.writeFile(
    path.join(bin, process.platform === "win32" ? "git.cmd" : "git"),
    process.platform === "win32"
      ? `@echo off\r\n${invocation.map((value) => `"${value}"`).join(" ")} %*\r\n`
      : `#!/bin/sh\nexec ${invocation.map(quote).join(" ")} "$@"\n`,
    { mode: 0o700 },
  );
  const pathEnv = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

  const first = startBackup(root, repositoryPath, "global", pathEnv);
  let second: ReturnType<typeof startBackup> | undefined;
  const wait = <T>(promise: Promise<T>) => withinTest(promise, signal);
  try {
    await wait(
      awaitGateBeforeSettlement(
        gate("global.pre-commit").promise,
        first.finished,
        "global commit gate",
      ),
    );
    second = startBackup(root, path.join(alias, "repository"), "agent", pathEnv);
    // Pre-fix, the second private index reaches commit with the old base. With
    // serialization it must first contend on the real cross-process lock.
    const admission = await wait(
      awaitGateBeforeSettlement(
        Promise.race([
          second.contended.then(() => "locked" as const),
          gate("agent.pre-commit").promise.then(() => "commit" as const),
        ]),
        second.finished,
        "agent admission gate",
      ),
    );
    release("global.pre-commit");
    await wait(
      awaitGateBeforeSettlement(
        gate("global.pre-push").promise,
        first.finished,
        "global push gate",
      ),
    );
    if (admission === "commit") {
      release("agent.pre-commit");
      await wait(
        awaitGateBeforeSettlement(
          gate("agent.pre-push").promise,
          second.finished,
          "agent push gate",
        ),
      );
    } else {
      expect(
        await fs.readFile(path.join(repositoryPath, "agents/fixture/tables/payload.jsonl"), "utf8"),
      ).toBe('{"id":1,"value":"old"}\n');
    }
    release("global.pre-push");
    const firstResult = await wait(first.finished);
    if (admission === "locked") {
      await wait(
        awaitGateBeforeSettlement(
          gate("agent.pre-commit").promise,
          second.finished,
          "agent commit gate",
        ),
      );
      release("agent.pre-commit");
      await wait(
        awaitGateBeforeSettlement(
          gate("agent.pre-push").promise,
          second.finished,
          "agent push gate",
        ),
      );
    }
    release("agent.pre-push");
    const secondResult = await wait(second.finished);
    const head = await git("rev-parse", "HEAD");
    expect(await git("show", `${head}:global/tables/payload.jsonl`)).toBe(
      '{"id":1,"value":"new-global"}',
    );
    expect(await git("show", `${head}:agents/fixture/tables/payload.jsonl`)).toBe(
      '{"id":1,"value":"new-agent"}',
    );
    expect(firstResult.commit).not.toBe(secondResult.commit);
    expect(secondResult.commit).toBe(head);
    for (const result of [firstResult, secondResult]) {
      expect(result).toMatchObject({ noChanges: false, pushed: true, warnings: [] });
      expect(result.pushWarning).toBeUndefined();
      const manifest = result.manifests[0]!;
      const verified = await verifyGitBackupRef({
        repositoryPath,
        identity: manifest.identity,
        ref: result.commit,
      });
      expect(verified.manifest).toEqual(manifest);
    }
    const branch = await git("symbolic-ref", "HEAD");
    expect(await requireGit(remotePath, ["rev-parse", branch])).toBe(head);
    expect(await git("rev-parse", `:${extra}`)).toBe(stagedBlob);
    expect(await git("status", "--porcelain")).toBe(`AM ${extra}`);
  } finally {
    for (const scope of ["global", "agent"]) {
      for (const phase of ["pre-commit", "pre-push"]) {
        release(`${scope}.${phase}`);
      }
    }
    for (const process of [first, second]) {
      if (process && process.child.exitCode === null && process.child.signalCode === null) {
        process.child.kill("SIGTERM");
      }
    }
    await Promise.allSettled([first.finished, ...(second ? [second.finished] : [])]);
    for (const socket of sockets.values()) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}, 30_000);
