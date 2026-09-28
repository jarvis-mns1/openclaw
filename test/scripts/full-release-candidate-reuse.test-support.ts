import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  canonicalTestJson,
  fullReleaseCandidateManifestFixture,
} from "../helpers/full-release-candidate.js";

export const NOW = Date.parse("2026-08-28T12:00:00Z");
export const EXPIRES_AT = "2026-09-04T12:00:00Z";
export const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function archiveWithManifest(value: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "full-release-candidate.json",
    typeof value === "string" ? value : canonicalTestJson(value),
    { date: new Date("2026-08-28T00:00:00Z") },
  );
  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "nodebuffer",
  });
}

export function workflowRun(
  runId = 77,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "release-ci/tooling",
    head_repository: { full_name: REPOSITORY, id: 1 },
    head_sha: "b".repeat(40),
    id: runId,
    path: `${WORKFLOW_PATH}@refs/heads/release-ci/tooling`,
    repository: { full_name: REPOSITORY, id: 1 },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

export function workflowJobs(
  manifest = fullReleaseCandidateManifestFixture(),
  overrides: { runAttempt?: number; runId?: number } = {},
) {
  const runAttempt = overrides.runAttempt ?? Number(manifest.producer.runAttempt);
  const runId = overrides.runId ?? Number(manifest.producer.runId);
  return {
    jobs: [
      {
        conclusion: "success",
        head_sha: manifest.producer.workflowSha,
        id: Number(manifest.producer.jobId),
        name: manifest.producer.jobName,
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
      {
        conclusion: "success",
        head_sha: manifest.publisher.workflowSha,
        id: Number(manifest.publisher.jobId),
        name: manifest.publisher.jobName,
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
    ],
    total_count: 2,
  };
}

export function artifactMetadata(
  archive: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const manifest = fullReleaseCandidateManifestFixture();
  return {
    created_at: "2026-08-28T10:00:00Z",
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: EXPIRES_AT,
    id: 301,
    name: `full-release-candidate-v2-${manifest.requestSha256}`,
    size_in_bytes: archive.length,
    workflow_run: {
      head_repository_id: 1,
      head_sha: manifest.request.toolingSha,
      id: 77,
      repository_id: 1,
    },
    ...overrides,
  };
}

type CandidateManifestFixture = ReturnType<typeof fullReleaseCandidateManifestFixture>;
type CandidateArtifactFixture = CandidateManifestFixture["package"]["artifact"];
type CandidateConstituentSource = Pick<
  CandidateManifestFixture,
  "package" | "prepublishPluginRegistry" | "producer" | "sharedImage"
>;

function constituentArtifactMetadata(
  artifact: CandidateArtifactFixture,
  workflowSha: string,
): Record<string, unknown> {
  return {
    digest: `sha256:${artifact.digest}`,
    expired: false,
    expires_at: artifact.expiresAt,
    id: Number(artifact.id),
    name: artifact.name,
    workflow_run: {
      head_sha: workflowSha,
      id: Number(artifact.runId),
    },
  };
}

export function constituentArtifactReader(manifest: CandidateConstituentSource) {
  const artifacts = [
    manifest.package.artifact,
    manifest.prepublishPluginRegistry.artifact,
    manifest.sharedImage.artifact,
  ];
  return async (artifactId: string) => {
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) {
      throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
    }
    return constituentArtifactMetadata(artifact, manifest.producer.workflowSha);
  };
}

export async function fixture(expiresAt = EXPIRES_AT) {
  const manifest = fullReleaseCandidateManifestFixture();
  for (const artifact of [
    manifest.package.artifact,
    manifest.prepublishPluginRegistry.artifact,
    manifest.sharedImage.artifact,
  ]) {
    artifact.expiresAt = expiresAt;
  }
  const archive = await archiveWithManifest(manifest);
  return {
    archive,
    manifest,
    metadata: artifactMetadata(archive, { expires_at: expiresAt }),
  };
}
