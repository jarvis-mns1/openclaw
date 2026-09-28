import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyReleaseSnapshot,
  hydrateReusedPlan,
  readChild,
} from "../../scripts/full-release-validation-state.mjs";
import {
  child,
  reusedEvidenceChildren,
  SHA,
} from "./full-release-validation-state.test-support.js";

describe("release child collection", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_REPOSITORY", "openclaw/openclaw");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["fresh", "reused"] as const)(
    "accepts a human child rerun with retained earlier jobs in a %s plan",
    async (source) => {
      const original = child("normalCi");
      const planned =
        source === "reused"
          ? hydrateReusedPlan([original], {
              children: [
                {
                  ...reusedEvidenceChildren()[0],
                  displayTitle: original.displayTitle,
                  runAttempt: 2,
                },
              ],
              manifest: { childEvidence: { normalCi: { plannedRunAttempt: 1 } } },
            })[0]
          : original;
      assert(planned, "selected child remains present in the reused plan");
      const result = await readChild(planned, undefined, undefined, {
        readRun: async () => ({
          actor: { login: "github-actions[bot]" },
          conclusion: "success",
          display_title: original.displayTitle,
          event: "workflow_dispatch",
          head_branch: original.workflowRef,
          head_sha: SHA,
          html_url: original.url,
          id: 101,
          path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 2,
          status: "completed",
          triggering_actor: { login: "release-operator" },
        }),
        readAttemptJobs: async (_runId, attempt) =>
          attempt === 1
            ? [
                { name: "lint", status: "completed", conclusion: "success" },
                { name: "test", status: "completed", conclusion: "failure" },
              ]
            : [{ name: "test", status: "completed", conclusion: "success" }],
      });
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({
        observedRunAttempts: [1, 2],
        plannedRunAttempt: 1,
        runAttempt: 2,
        triggeringActor: "release-operator",
      });
      expect(result.jobs).toEqual([
        expect.objectContaining({ name: "lint", acceptedRunAttempt: 1, conclusion: "success" }),
        expect.objectContaining({ name: "test", acceptedRunAttempt: 2, conclusion: "success" }),
      ]);
    },
  );

  it.each([
    "HTTP 503: Server Error",
    "HTTP 429: API rate limit exceeded",
    "HTTP 403: secondary rate limit",
    "read ECONNRESET",
  ])("preserves the last valid snapshot through %s and then recovers", async (message) => {
    const planned = child("normalCi");
    const previous = {
      ...planned,
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      status: "completed",
    };
    let fail = true;
    const readRun = async () => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error(message), {
          stderr: message,
        });
      }
      return {
        actor: { login: "github-actions[bot]" },
        conclusion: "success",
        created_at: "2026-08-21T00:00:00Z",
        display_title: planned.displayTitle,
        event: "workflow_dispatch",
        head_branch: planned.workflowRef,
        head_sha: planned.workflowSha,
        html_url: planned.url,
        id: 101,
        path: ".github/workflows/ci.yml",
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: 1,
        status: "completed",
        triggering_actor: { login: "github-actions[bot]" },
        updated_at: "2026-08-21T00:01:00Z",
      };
    };
    const readAttemptJobs = async () => [
      {
        completed_at: "2026-08-21T00:01:00Z",
        conclusion: "success",
        html_url: "https://example.invalid/jobs/test",
        name: "test",
        started_at: "2026-08-21T00:00:00Z",
        status: "completed",
      },
    ];

    const degraded = await readChild(planned, previous, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(degraded).toMatchObject({
      conclusion: "success",
      errors: [],
      jobs: previous.jobs,
      status: "transport_uncertain",
    });
    expect(
      classifyReleaseSnapshot({
        children: [degraded],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "qualifying" });

    const recovered = await readChild(planned, degraded, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(recovered).toMatchObject({
      conclusion: "success",
      errors: [],
      status: "completed",
    });
    expect(
      classifyReleaseSnapshot({
        children: [recovered],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "passed" });
  });

  it("keeps exhausted transient reads uncertain instead of terminal", async () => {
    const planned = child("normalCi");
    const readRun = async () => {
      throw Object.assign(new Error("HTTP 503: Server Error"), {
        stderr: "HTTP 503: Server Error",
      });
    };
    let snapshot: Record<string, unknown> = planned;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      snapshot = await readChild(planned, snapshot, undefined, { readRun });
    }
    expect(snapshot).toMatchObject({
      errors: [],
      status: "transport_uncertain",
    });
    expect(
      classifyReleaseSnapshot({
        children: [snapshot],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({
      errors: [],
      state: "qualifying",
    });
  });

  it("keeps degraded reads nonterminal and cancellation-visible", async () => {
    const planned = child("normalCi");
    const degraded = await readChild(planned, planned, undefined, {
      readRun: async () => {
        throw Object.assign(new Error("read ECONNRESET"), { stderr: "read ECONNRESET" });
      },
    });
    expect(
      classifyReleaseSnapshot({
        cancelled: true,
        children: [degraded],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({
      activeRunIds: ["101"],
      errors: [],
      state: "cancelled_with_children",
    });
  });

  it.each([
    { name: "workflow SHA", overrides: { head_sha: "c".repeat(40) } },
    { name: "repository", overrides: { repository: { full_name: "example/unrelated" } } },
  ])("fails $name mismatches without consuming preserved success", async ({ overrides }) => {
    const planned = child("normalCi");
    const observed = await readChild(
      planned,
      { ...planned, conclusion: "success", status: "completed" },
      undefined,
      {
        readAttemptJobs: async () => [],
        readRun: async () => ({
          actor: { login: "github-actions[bot]" },
          conclusion: "success",
          display_title: planned.displayTitle,
          event: "workflow_dispatch",
          head_branch: planned.workflowRef,
          head_sha: planned.workflowSha,
          id: 101,
          path: ".github/workflows/ci.yml",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 1,
          status: "completed",
          triggering_actor: { login: "github-actions[bot]" },
          ...overrides,
        }),
      },
    );
    expect(observed.errors).toEqual([expect.objectContaining({ kind: "provenance_mismatch" })]);
    expect(
      classifyReleaseSnapshot({
        children: [observed],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ state: "orchestration_error" });
  });

  it.each(["HTTP 403: Resource not accessible by integration", "HTTP 403: Bad credentials"])(
    "keeps %s terminal",
    async (message) => {
      const planned = child("normalCi");
      const observed = await readChild(planned, planned, undefined, {
        readRun: async () => {
          throw Object.assign(new Error(message), { stderr: message });
        },
      });
      expect(observed).toMatchObject({
        errors: [expect.objectContaining({ kind: "api_error" })],
        transportFailure: undefined,
      });
    },
  );

  it("keeps malformed child responses terminal", async () => {
    const planned = child("normalCi");
    const observed = await readChild(planned, planned, undefined, {
      readRun: async () => ({}),
    });
    expect(observed.errors).toEqual([expect.objectContaining({ kind: "api_error" })]);
  });

  it("preserves complete composite evidence when the run read succeeds but jobs fail", async () => {
    const planned = child("normalCi");
    const previous = {
      ...planned,
      compositeJobsSha256: "f".repeat(64),
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      status: "completed",
      transportFailure: { errorClass: "transient" },
    };
    const observed = await readChild(planned, previous, undefined, {
      readAttemptJobs: async (_runId, attempt) => {
        if (attempt === 2) {
          throw Object.assign(new Error("HTTP 503: Server Error"), {
            stderr: "HTTP 503: Server Error",
          });
        }
        return previous.jobs;
      },
      readRun: async () => ({
        actor: { login: "github-actions[bot]" },
        conclusion: "",
        display_title: planned.displayTitle,
        event: "workflow_dispatch",
        head_branch: planned.workflowRef,
        head_sha: planned.workflowSha,
        id: 101,
        path: ".github/workflows/ci.yml",
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: 2,
        status: "in_progress",
        triggering_actor: { login: "github-actions[bot]" },
      }),
    });
    expect(observed).toMatchObject({
      compositeJobsSha256: previous.compositeJobsSha256,
      jobs: previous.jobs,
      runAttempt: 1,
      status: "transport_uncertain",
      transportFailure: { errorClass: "transient" },
    });
    expect(
      await readChild(
        planned,
        {
          ...planned,
          status: "transport_uncertain",
          transportFailure: { errorClass: "transient" },
        },
        undefined,
        {
          readAttemptJobs: async () => [],
          readRun: async () => ({
            actor: { login: "github-actions[bot]" },
            display_title: planned.displayTitle,
            event: "workflow_dispatch",
            head_branch: planned.workflowRef,
            head_sha: planned.workflowSha,
            id: 101,
            path: ".github/workflows/ci.yml",
            repository: { full_name: "openclaw/openclaw" },
            run_attempt: 1,
            status: "in_progress",
            triggering_actor: { login: "github-actions[bot]" },
          }),
        },
      ),
    ).toMatchObject({
      status: "in_progress",
      transportFailure: { errorClass: "transient" },
    });
  });
});
