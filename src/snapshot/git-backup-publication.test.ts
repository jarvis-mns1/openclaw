import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createGitBackup } from "./git-backup.js";
import { createStateDatabaseFixture, gitBackupRepository } from "./git-backup.test-support.js";

const mocks = vi.hoisted(() => ({ beforePush: undefined as (() => Promise<void>) | undefined }));
vi.mock("../infra/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/git-exec.js")>();
  return {
    ...actual,
    executeGitCommand: async (
      ...args: Parameters<typeof actual.executeGitCommand>
    ): ReturnType<typeof actual.executeGitCommand> => {
      if (args[1][0] === "push") {
        await mocks.beforePush?.();
      }
      return await actual.executeGitCommand(...args);
    },
  };
});

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  mocks.beforePush = undefined;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it("pushes the captured backup commit even if HEAD moves before publication", async () => {
  const root = roots.make("git-backup-publication-");
  const { database } = createStateDatabaseFixture(root);
  const repository = gitBackupRepository(root);
  const remotePath = path.join(root, "remote.git");
  await requireGit(root, ["init", "--bare", remotePath]);
  await repository.init(remotePath);
  await repository.configureIdentity();
  let capturedCommit: string | undefined;
  mocks.beforePush = async () => {
    capturedCommit = await repository.git("rev-parse", "HEAD");
    const tree = await repository.git("rev-parse", "HEAD^{tree}");
    const moved = await repository.git(
      "commit-tree",
      tree,
      "-p",
      capturedCommit,
      "-m",
      "Operator change after backup",
    );
    await repository.git("update-ref", "HEAD", moved, capturedCommit);
  };
  const params = { ...repository.options, databases: [database], push: true };
  const result = await createGitBackup(params);
  const branch = await repository.git("symbolic-ref", "HEAD");
  expect(result).toMatchObject({ noChanges: false, pushed: true });
  expect(result).not.toHaveProperty("pushWarning");
  expect(result.commit).toBe(capturedCommit);
  expect(await repository.git("rev-parse", "HEAD")).not.toBe(result.commit);
  expect(await requireGit(remotePath, ["rev-parse", branch])).toBe(result.commit);

  mocks.beforePush = undefined;
  await repository.git("update-ref", "HEAD", result.commit!);
  const unchanged = await createGitBackup(params);
  expect(unchanged).toMatchObject({ noChanges: true, pushed: true, commit: result.commit });
});
