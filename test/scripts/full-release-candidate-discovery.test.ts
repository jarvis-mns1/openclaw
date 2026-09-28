import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  fixture,
  NOW,
  REPOSITORY,
  workflowJobs,
  workflowRun,
} from "./full-release-candidate-reuse.test-support.js";

const CONTRACT_SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const SCRIPT = resolve("scripts/full-release-candidate-reuse.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("full release candidate discovery CLI", () => {
  it("preserves canonical request arrays when checking the expected digest", () => {
    const root = tempDirs.make("full-release-candidate-canonical-");
    const bin = join(root, "bin");
    const rawInputPath = join(root, "raw-request-input.json");
    const requestPath = join(root, "request.json");
    const outputPath = join(root, "github-output");
    const callLogPath = join(root, "gh-calls");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_CALL_LOG"
printf '%s\n' '{"artifacts":[]}'
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      rawInputPath,
      JSON.stringify(
        fullReleaseCandidateRequestInput({
          upgradeSurvivorBaselines: "openclaw@latest",
          upgradeSurvivorScenarios: "base",
        }),
      ),
    );
    const contractResult = spawnSync(
      process.execPath,
      [CONTRACT_SCRIPT, "request", "--input", rawInputPath, "--output", requestPath],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(contractResult.status, contractResult.stderr).toBe(0);
    const contract = JSON.parse(contractResult.stdout) as {
      requestJson: string;
      requestSha256: string;
    };
    const requestBeforeDiscovery = readFileSync(requestPath, "utf8");
    const request = JSON.parse(requestBeforeDiscovery) as {
      upgradeSurvivorBaselines: string[];
      upgradeSurvivorScenarios: string[];
    };
    expect(request.upgradeSurvivorBaselines).toEqual(["openclaw@latest"]);
    expect(request.upgradeSurvivorScenarios).toEqual(["base"]);

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "discover",
        "--request-input",
        requestPath,
        "--expected-request-sha256",
        contract.requestSha256,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_GH_CALL_LOG: callLogPath,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          PATH: `${bin}:${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(outputs).toMatchObject({
      request_json: contract.requestJson,
      request_sha256: contract.requestSha256,
      reused: "false",
      state: "miss",
    });
    expect(readFileSync(requestPath, "utf8")).toBe(requestBeforeDiscovery);
    expect(readFileSync(callLogPath, "utf8").trim()).toBe(
      `api repos/${REPOSITORY}/actions/artifacts?name=full-release-candidate-v2-${contract.requestSha256}&per_page=100&page=1`,
    );
  });

  it("marks exhausted transient reads unavailable instead of permitting preparation", () => {
    const root = tempDirs.make("full-release-candidate-discovery-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
echo "HTTP 502: transient candidate lookup failure" >&2
exit 1
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate discovery unavailable after bounded retries",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });

  it("marks bounded artifact inventory exhaustion unavailable instead of permitting preparation", () => {
    const root = tempDirs.make("full-release-candidate-inventory-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const payloadPath = join(root, "artifacts.json");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
cat "$FAKE_GH_PAYLOAD"
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(
      payloadPath,
      JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({})) }),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        FAKE_GH_PAYLOAD: payloadPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("10");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate artifact inventory exceeded the bounded scan",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });

  it("marks bounded candidate evaluation unavailable when older candidates remain", async () => {
    const root = tempDirs.make("full-release-candidate-evaluation-");
    const bin = join(root, "bin");
    const responses = join(root, "responses");
    const callLogPath = join(root, "gh-calls");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const artifactListingPath = join(root, "artifacts.json");
    mkdirSync(bin);
    mkdirSync(responses);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_CALL_LOG"
case "$*" in
  *"actions/artifacts?name="*) cat "$FAKE_GH_ARTIFACT_LISTING" ;;
  *"/jobs?filter=all"*)
    run_id="$(printf '%s' "$*" | sed -E 's#.*actions/runs/([0-9]+)/jobs.*#\\1#')"
    cat "$FAKE_GH_RESPONSES/jobs-$run_id.json"
    ;;
  *"actions/runs/"*)
    run_id="$(printf '%s' "$*" | sed -E 's#.*actions/runs/([0-9]+).*#\\1#')"
    cat "$FAKE_GH_RESPONSES/run-$run_id.json"
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 2
    ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const { manifest, metadata } = await fixture(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const artifacts = Array.from({ length: 6 }, (_, index) => {
      const runId = 80 + index;
      const jobs = workflowJobs(manifest, { runId });
      jobs.jobs[1]!.conclusion = runId === 85 ? "success" : "failure";
      writeFileSync(join(responses, `run-${runId}.json`), JSON.stringify(workflowRun(runId)));
      writeFileSync(join(responses, `jobs-${runId}.json`), JSON.stringify([jobs]));
      return {
        ...metadata,
        created_at: new Date(NOW - index * 1000).toISOString(),
        id: 400 + index,
        workflow_run: {
          head_repository_id: 1,
          head_sha: manifest.request.toolingSha,
          id: runId,
          repository_id: 1,
        },
      };
    });
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(artifactListingPath, JSON.stringify({ artifacts }));
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_ARTIFACT_LISTING: artifactListingPath,
        FAKE_GH_CALL_LOG: callLogPath,
        FAKE_GH_RESPONSES: responses,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate evaluation exceeded the bounded scan",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).not.toContain("state=miss");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
    const candidateCalls = readFileSync(callLogPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("actions/runs/"));
    expect(candidateCalls).toEqual(
      [80, 81, 82, 83, 84].flatMap((runId) => [
        `api repos/${REPOSITORY}/actions/runs/${runId}`,
        `api --paginate --slurp repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      ]),
    );
    expect(candidateCalls.join("\n")).not.toContain("actions/runs/85");
  });

  it("marks a selected candidate with a missing constituent unavailable", async () => {
    const root = tempDirs.make("full-release-candidate-selected-missing-");
    const bin = join(root, "bin");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const archivePath = join(root, "candidate.zip");
    const artifactListingPath = join(root, "artifacts.json");
    const workflowRunPath = join(root, "workflow-run.json");
    const workflowJobsPath = join(root, "workflow-jobs.json");
    const artifactMetadataPath = join(root, "artifact-metadata.json");
    const fetchPreloadPath = join(root, "fetch-preload.mjs");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
case "$*" in
  *"actions/artifacts?name="*) cat "$FAKE_GH_ARTIFACT_LISTING" ;;
  *"actions/runs/77/jobs?filter=all"*) cat "$FAKE_GH_WORKFLOW_JOBS" ;;
  *"actions/runs/77"*) cat "$FAKE_GH_WORKFLOW_RUN" ;;
  *"actions/artifacts/101"*)
    echo "HTTP 404: candidate constituent artifact missing" >&2
    exit 1
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 2
    ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const { archive, manifest, metadata } = await fixture(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(archivePath, archive);
    writeFileSync(artifactListingPath, JSON.stringify({ artifacts: [metadata] }));
    writeFileSync(workflowRunPath, JSON.stringify(workflowRun()));
    writeFileSync(workflowJobsPath, JSON.stringify([workflowJobs(manifest)]));
    writeFileSync(artifactMetadataPath, JSON.stringify(metadata));
    writeFileSync(
      fetchPreloadPath,
      `import { readFileSync } from "node:fs";
const archive = readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE);
const metadata = JSON.parse(readFileSync(process.env.FAKE_ARTIFACT_METADATA, "utf8"));
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.endsWith("/actions/artifacts/301")) {
    return new Response(JSON.stringify(metadata), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }
  if (value.endsWith("/actions/artifacts/301/zip")) {
    return new Response(archive, { status: 200 });
  }
  throw new Error(\`unexpected fetch: \${value}\`);
};
`,
    );
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_ARTIFACT_ARCHIVE: archivePath,
        FAKE_ARTIFACT_METADATA: artifactMetadataPath,
        FAKE_GH_ARTIFACT_LISTING: artifactListingPath,
        FAKE_GH_WORKFLOW_JOBS: workflowJobsPath,
        FAKE_GH_WORKFLOW_RUN: workflowRunPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        NODE_OPTIONS: `--import=${pathToFileURL(fetchPreloadPath).href}`,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=full release candidate package artifact is unavailable",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).not.toContain("state=miss");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });
});
