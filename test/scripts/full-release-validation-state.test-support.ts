export const SHA = "a".repeat(40);

export function child(key: string, overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "",
    dispatchName: `Dispatch ${key}`,
    displayTitle: key,
    errors: [],
    jobs: [],
    key,
    required: true,
    result: "success",
    runAttempt: 1,
    runId: "101",
    selected: true,
    source: "fresh",
    status: "in_progress",
    url: "https://example.invalid/runs/101",
    workflow: "ci.yml",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
}

export function reusedEvidenceChildren() {
  return [
    ["normalCi", "101", "CI"],
    ["pluginPrerelease", "202", "Plugin Prerelease"],
    ["releaseChecks", "303", "OpenClaw Release Checks"],
    ["productPerformance", "505", "OpenClaw Performance"],
  ].map(([role, runId, name]) => ({
    displayTitle: `${name} full-release-validation-99-1`,
    headBranch: "release-ci/tooling",
    role,
    runAttempt: 1,
    runId,
    url: `https://example.invalid/runs/${runId}`,
    workflowSha: SHA,
  }));
}
