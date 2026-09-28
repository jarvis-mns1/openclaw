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
