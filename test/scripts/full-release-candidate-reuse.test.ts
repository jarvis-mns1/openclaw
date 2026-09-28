import { describe, expect, it } from "vitest";
import { downloadExactActionsArtifactArchive } from "../../scripts/lib/actions-artifact-archive.mjs";
import {
  candidateArtifactJsonFromBinding,
  loadSelectedFullReleaseCandidate,
  resolveCandidateBinding,
  selectTrustedFullReleaseCandidate,
  verifySealedFullReleaseCandidate,
} from "../../scripts/lib/full-release-candidate-reuse.mjs";
import { fullReleaseCandidateBindingFixture } from "../helpers/full-release-candidate.js";
import {
  archiveWithManifest,
  artifactMetadata,
  constituentArtifactReader,
  EXPIRES_AT,
  fixture,
  NOW,
  REPOSITORY,
  sha256,
  workflowJobs,
  workflowRun,
} from "./full-release-candidate-reuse.test-support.js";

describe("trusted full release candidate selection", () => {
  it("treats malformed metadata and workflow provenance as misses before selection", async () => {
    const { archive, manifest, metadata } = await fixture();
    let runReads = 0;
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        { ...metadata, name: "wrong" },
        { ...metadata, digest: "" },
        { ...metadata, expired: true },
        { ...metadata, expires_at: "2026-08-28T11:59:59Z" },
        { ...metadata, expires_at: "2026-08-28T13:59:59Z" },
        {
          ...artifactMetadata(archive, { id: 302 }),
          workflow_run: {
            head_repository_id: 2,
            head_sha: manifest.request.toolingSha,
            id: 78,
            repository_id: 1,
          },
        },
        {
          ...artifactMetadata(archive, { id: 303 }),
          workflow_run: {
            head_repository_id: 1,
            head_sha: "9".repeat(40),
            id: 79,
            repository_id: 1,
          },
        },
      ],
      now: NOW,
      readWorkflowRun: async () => {
        runReads += 1;
        return workflowRun();
      },
      readWorkflowJobs: async () => {
        throw new Error("workflow jobs must not be read");
      },
      request: manifest.request,
    });
    expect(selected).toBeNull();
    expect(runReads).toBe(0);
  });

  it("orders candidates by newest creation time then descending numeric artifact ID", async () => {
    const { archive, manifest } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        artifactMetadata(archive, { id: 9 }),
        artifactMetadata(archive, { id: 10 }),
        artifactMetadata(archive, { created_at: "2026-08-28T09:00:00Z", id: 99 }),
      ],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(10);
  });

  it("accepts an active trusted parent after its publisher job succeeds", async () => {
    const { manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("requires enough remaining lifetime for the longest release-validation drain", async () => {
    const { archive, manifest } = await fixture();
    const tooShort = artifactMetadata(archive, {
      expires_at: new Date(NOW + 13 * 60 * 60 * 1000).toISOString(),
    });
    const longEnough = artifactMetadata(archive, {
      expires_at: new Date(NOW + 15 * 60 * 60 * 1000).toISOString(),
      id: 302,
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [tooShort, longEnough],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(302);
  });

  it("stops provenance reads when the discovery deadline is exhausted", async () => {
    const { manifest, metadata } = await fixture();
    let reads = 0;
    await expect(
      selectTrustedFullReleaseCandidate({
        artifacts: [metadata],
        deadlineMs: Date.now() - 1,
        now: NOW,
        readWorkflowRun: async () => {
          reads += 1;
          return workflowRun();
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(reads).toBe(0);
  });

  it("skips an artifact whose trusted publisher job did not succeed", async () => {
    const { archive, manifest, metadata } = await fixture();
    const newest = artifactMetadata(archive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => {
        const jobs = workflowJobs(manifest, { runId });
        if (runId === 78) {
          jobs.jobs[1]!.conclusion = "failure";
        }
        return jobs;
      },
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("skips a trust miss but never falls back after selecting malformed evidence", async () => {
    const { manifest, metadata } = await fixture();
    const malformedArchive = await archiveWithManifest("{");
    const newest = artifactMetadata(malformedArchive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => workflowJobs(manifest, { runId }),
      request: manifest.request,
    });
    const downloads: number[] = [];
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async ({ expected }) => {
          downloads.push((expected as { artifactId: number }).artifactId);
          return { archiveBytes: malformedArchive, artifactMetadata: newest };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(78),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("manifest input is invalid JSON");
    expect(downloads).toEqual([302]);
  });
});

describe("candidate archive deadline", () => {
  it("does not start artifact metadata reads after the absolute deadline", async () => {
    let reads = 0;
    await expect(
      downloadExactActionsArtifactArchive({
        deadlineMs: Date.now() - 1,
        expected: {
          artifactDigest: `sha256:${"a".repeat(64)}`,
          artifactExpiresAt: EXPIRES_AT,
          artifactId: 301,
          artifactName: `full-release-candidate-v2-${"b".repeat(64)}`,
          artifactSizeBytes: 1,
          repository: REPOSITORY,
          runId: 77,
          workflowSha: "b".repeat(40),
        },
        fetchImpl: async () => {
          reads += 1;
          return new Response();
        },
        token: "test-token",
      }),
    ).rejects.toThrow("deadline exceeded");
    expect(reads).toBe(0);
  });
});

describe("full release candidate loading", () => {
  it("binds the exact archive, producer attempt, and producer job", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { run_attempt: 2 }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async ({ expected }) => {
        expect(expected).toMatchObject({
          artifactId: 301,
          artifactName: metadata.name,
          runId: 77,
          workflowSha: manifest.request.toolingSha,
        });
        return { archiveBytes: archive, artifactMetadata: metadata };
      },
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async (runId, runAttempt) => {
        expect([runId, runAttempt]).toEqual(["77", "1"]);
        return workflowRun(77, { run_attempt: 1 });
      },
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    expect(binding).toMatchObject({
      evidenceArtifact: {
        digest: sha256(archive),
        id: "301",
        runAttempt: "1",
        runId: "77",
      },
      producer: manifest.producer,
      publisher: manifest.publisher,
      request: manifest.request,
    });
  });

  it("accepts an active producer run after the exact producer jobs complete", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).resolves.toMatchObject({ producer: manifest.producer });
  });

  it("stops candidate loading when the discovery deadline is exhausted", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    let downloads = 0;
    await expect(
      loadSelectedFullReleaseCandidate({
        deadlineMs: Date.now() - 1,
        downloadArchive: async () => {
          downloads += 1;
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(downloads).toBe(0);
  });

  it("rejects unavailable, expired, or changed constituent artifacts before reuse", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const packageId = manifest.package.artifact.id;
    const cases = [
      {
        expected: "package artifact is unavailable",
        readArtifact: async (artifactId: string) => {
          if (artifactId === packageId) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(manifest)(artifactId);
        },
      },
      {
        expected: "package artifact is expired or near expiry",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId ? { ...value, expired: true } : value;
        },
      },
      {
        expected: "package artifact identity changed",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId
            ? { ...value, digest: `sha256:${"9".repeat(64)}` }
            : value;
        },
      },
    ];
    for (const testCase of cases) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
          now: NOW,
          readArtifact: testCase.readArtifact,
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(testCase.expected);
    }
  });

  it("rejects a manifest producer workflow that differs from the selected run", async () => {
    const { manifest } = await fixture();
    const changedManifest = structuredClone(manifest);
    changedManifest.producer.workflowPath = ".github/workflows/candidate-evidence-test.yml";
    const archive = await archiveWithManifest(changedManifest);
    const metadata = artifactMetadata(archive);
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(changedManifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(changedManifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("producer or publisher workflow attempt is invalid");
  });

  it("rejects a manifest publisher workflow that differs from the selected run", async () => {
    const { manifest } = await fixture();
    const changedManifest = structuredClone(manifest);
    changedManifest.publisher.workflowPath = ".github/workflows/candidate-evidence-test.yml";
    const archive = await archiveWithManifest(changedManifest);
    const metadata = artifactMetadata(archive);
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(changedManifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(changedManifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("producer or publisher workflow attempt is invalid");
  });

  it("hard-fails an unavailable, changed, or expired selected artifact", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    for (const error of [
      new Error("GitHub Actions artifact metadata returned HTTP 404."),
      new Error("Actions artifact metadata does not match the exact artifact tuple."),
      new Error("full release candidate binding contains expired artifact evidence"),
    ]) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => {
            throw error;
          },
          now: NOW,
          readArtifact: constituentArtifactReader(manifest),
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(error.message);
    }
    expect(archive.length).toBeGreaterThan(0);
  });

  it.each([
    ["job id", (jobs) => void (jobs.jobs[1]!.id = 999)],
    ["job name", (jobs) => void (jobs.jobs[1]!.name = "different publisher")],
    ["job conclusion", (jobs) => void (jobs.jobs[1]!.conclusion = "failure")],
  ] satisfies Array<[string, (jobs: ReturnType<typeof workflowJobs>) => void]>)(
    "rejects evidence when the publisher %s differs from the sealed identity",
    async (_label, mutate) => {
      const { archive, manifest, metadata } = await fixture();
      const selected = await selectTrustedFullReleaseCandidate({
        artifacts: [metadata],
        now: NOW,
        readWorkflowRun: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
      });
      const jobs = workflowJobs(manifest);
      mutate(jobs);
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
          now: NOW,
          readArtifact: constituentArtifactReader(manifest),
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => jobs,
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow("publisher job did not complete successfully");
    },
  );
});

describe("full release candidate binding authority", () => {
  it("normalizes fresh and reused evidence to the same downstream tuple", () => {
    const binding = fullReleaseCandidateBindingFixture();
    const fresh = resolveCandidateBinding({
      freshBinding: binding,
      now: NOW,
      request: binding.request,
      required: true,
    });
    const reused = resolveCandidateBinding({
      now: NOW,
      request: binding.request,
      required: true,
      reusedBinding: binding,
    });
    expect(fresh).toEqual(binding);
    expect(reused).toEqual(binding);
    expect(candidateArtifactJsonFromBinding(fresh)).toBe(candidateArtifactJsonFromBinding(reused));
  });

  it("rejects missing, ambiguous, expired, and wrong-request evidence", () => {
    const binding = fullReleaseCandidateBindingFixture();
    expect(() =>
      resolveCandidateBinding({ now: NOW, request: binding.request, required: true }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: binding.request,
        required: true,
        reusedBinding: binding,
      }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT),
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT) - 90 * 60 * 1000,
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: { ...binding.request, releaseProfile: "beta" },
        required: true,
      }),
    ).toThrow("does not match");
  });
});

describe("sealed full release candidate verification", () => {
  it("rechecks the exact evidence archive and producer tuple", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
            artifactExpiresAt: binding.evidenceArtifact.expiresAt,
            artifactId: Number(binding.evidenceArtifact.id),
            artifactName: binding.evidenceArtifact.name,
            runId: Number(binding.evidenceArtifact.runId),
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun();
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).resolves.toEqual(binding);

    const changedPublisherJobs = workflowJobs(manifest);
    changedPublisherJobs.jobs[1]!.id = 999;
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => changedPublisherJobs,
        token: "test-token",
      }),
    ).rejects.toThrow("publisher job did not complete successfully");
  });

  it("fails final verification when a sealed constituent artifact disappears", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          if (artifactId === binding.package.artifact.id) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("rejects an evidence artifact identity change before accepting the archive", async () => {
    const binding = fullReleaseCandidateBindingFixture();
    const metadata = {
      created_at: "2026-08-28T10:00:00Z",
      digest: `sha256:${binding.evidenceArtifact.digest}`,
      expired: false,
      expires_at: binding.evidenceArtifact.expiresAt,
      id: Number(binding.evidenceArtifact.id) + 1,
      name: binding.evidenceArtifact.name,
      size_in_bytes: 100,
      workflow_run: {
        head_repository_id: 1,
        head_sha: binding.producer.workflowSha,
        id: Number(binding.producer.runId),
        repository_id: 1,
      },
    };
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({ artifactId: Number(binding.evidenceArtifact.id) });
          throw new Error("Actions artifact metadata does not match the exact artifact tuple.");
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(),
        token: "test-token",
      }),
    ).rejects.toThrow("does not match the exact artifact tuple");
  });
});
