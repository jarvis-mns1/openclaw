import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

const origin = {
  runId: "tool-origin-run",
  sessionKey: "agent:work:original",
  agentId: "work",
};
const replacement = { agentId: "other", sessionKey: "agent:other:replacement" };
const textResult = { content: [{ type: "text", text: "fixture-result" }] };
type ToolFixture = {
  name: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult?: unknown;
  result: unknown;
  phases: Array<[string, string]>;
};
const fixtures: ToolFixture[] = [
  {
    name: "plan",
    toolName: "progress_card",
    args: { markdown: "Inspecting", plan: [{ step: "Inspect", status: "in_progress" }] },
    partialResult: textResult,
    result: textResult,
    phases: [
      ["item", "start"],
      ["tool", "start"],
      ["tool", "update"],
      ["item", "update"],
      ["plan", "update"],
      ["tool", "result"],
      ["item", "end"],
    ],
  },
  {
    name: "command output",
    toolName: "exec",
    args: { command: "printf fixture-output" },
    partialResult: { ...textResult, details: { status: "running", aggregated: "fixture-output" } },
    result: {
      ...textResult,
      details: { status: "completed", aggregated: "fixture-output", exitCode: 0, durationMs: 12 },
    },
    phases: [
      ["item", "start"],
      ["tool", "start"],
      ["tool", "update"],
      ["item", "update"],
      ["command_output", "delta"],
      ["tool", "result"],
      ["item", "end"],
      ["command_output", "end"],
    ],
  },
  {
    name: "approval",
    toolName: "exec",
    args: { command: "printf fixture-output" },
    result: {
      ...textResult,
      details: {
        status: "approval-pending",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        expiresAtMs: 1_800_000_000_000,
        host: "gateway",
        command: "printf fixture-output",
        cwd: "/tmp/ownership-fixture",
      },
    },
    phases: [
      ["item", "start"],
      ["tool", "start"],
      ["tool", "result"],
      ["item", "end"],
      ["approval", "requested"],
    ],
  },
  {
    name: "patch",
    toolName: "apply_patch",
    args: { patch: "*** Begin Patch" },
    result: {
      ...textResult,
      details: { summary: { added: ["added.ts"], modified: [], deleted: [] } },
    },
    phases: [
      ["item", "start"],
      ["tool", "start"],
      ["tool", "result"],
      ["item", "end"],
      ["patch", "end"],
    ],
  },
];
type SubscriptionHarness = ReturnType<typeof createSubscribedSessionHarness>;

function startTool(harness: SubscriptionHarness, fixture: ToolFixture) {
  harness.emit({
    type: "tool_execution_start",
    toolName: fixture.toolName,
    toolCallId: "owned-tool",
    args: fixture.args,
  });
}

async function finishTool(harness: SubscriptionHarness, fixture: ToolFixture) {
  if (fixture.partialResult) {
    harness.emit({
      type: "tool_execution_update",
      toolName: fixture.toolName,
      toolCallId: "owned-tool",
      args: fixture.args,
      partialResult: fixture.partialResult,
    });
  }
  harness.emit({
    type: "tool_execution_end",
    toolName: fixture.toolName,
    toolCallId: "owned-tool",
    isError: false,
    result: fixture.result,
  });
  await harness.subscription.waitForPendingEvents();
}

async function emitToolTurn(harness: SubscriptionHarness, fixture = fixtures[0]) {
  startTool(harness, fixture);
  await finishTool(harness, fixture);
}

describe("subscribed tool event ownership", () => {
  const subscriptions = new Set<SubscriptionHarness["subscription"]>();
  const listeners = new Set<() => void>();

  beforeEach(() => resetAgentEventsForTest());
  afterEach(() => {
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    subscriptions.clear();
    for (const stop of listeners) {
      stop();
    }
    listeners.clear();
    vi.restoreAllMocks();
    resetAgentEventsForTest();
  });

  function subscribe(params: Partial<Parameters<typeof createSubscribedSessionHarness>[0]> = {}) {
    const harness = createSubscribedSessionHarness({ ...origin, ...params });
    subscriptions.add(harness.subscription);
    return harness;
  }

  function collect() {
    const events: AgentEventRuntimePayload[] = [];
    listeners.add(onAgentRuntimeEvent((event) => events.push(event)));
    return events;
  }

  describe.each(fixtures)("$name", (fixture) => {
    it.each(["clear", "release"] as const)(
      "retains the original owner on late events after %s without an async scope",
      async (cleanup) => {
        const claimId =
          cleanup === "release"
            ? claimAgentRunContext(origin.runId, origin, { trackOwner: true, ownsContext: true })
            : undefined;
        if (cleanup === "clear") {
          registerAgentRunContext(origin.runId, origin);
        }
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const harness = subscribe();
        const events = collect();
        startTool(harness, fixture);
        await harness.subscription.waitForPendingEvents();
        if (cleanup === "clear") {
          clearAgentRunContext(origin.runId);
        } else {
          releaseAgentRunContext(origin.runId, claimId);
        }
        expect(getAgentRunContext(origin.runId)).toBeUndefined();
        registerAgentRunContext("another-run", replacement);

        await finishTool(harness, fixture);

        expect(events.map((event) => [event.stream, event.data.phase])).toEqual(fixture.phases);
        for (const event of events) {
          expect(event).toMatchObject({ ...origin, lifecycleGeneration });
        }
      },
    );

    it("keeps hidden events private in their retained execution scope after cleanup", async () => {
      const events = collect();
      await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
        registerAgentRunContext(origin.runId, {
          ...origin,
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
        const harness = subscribe();
        clearAgentRunContext(origin.runId);
        await emitToolTurn(harness, fixture);
      });

      expect(events.map((event) => [event.stream, event.data.phase])).toEqual(fixture.phases);
      for (const event of events) {
        expect(event).toMatchObject({
          runId: origin.runId,
          agentId: origin.agentId,
          controlUiVisible: false,
          projectSessionMessages: false,
          deliverySessionKey: origin.sessionKey,
        });
        expect(event.sessionKey).toBeUndefined();
        expect(Object.keys(event)).not.toContain("controlUiVisible");
        expect(Object.keys(event)).not.toContain("deliverySessionKey");
      }
    });

    it.each(["hidden-clear", "same-generation-replacement", "rotation"] as const)(
      "rejects observer events after %s but still settles the original callbacks",
      async (change) => {
        registerAgentRunContext(origin.runId, {
          ...origin,
          isControlUiVisible: change !== "hidden-clear",
        });
        const onAgentEvent = vi.fn();
        const harness = subscribe({ onAgentEvent });
        const originalContext = getAgentRunContext(origin.runId);
        clearAgentRunContext(origin.runId);
        if (change !== "hidden-clear") {
          registerAgentRunContext(origin.runId, {
            ...replacement,
            lifecycleGeneration:
              change === "rotation"
                ? rotateAgentEventLifecycleGeneration()
                : getAgentEventLifecycleGeneration(),
          });
          expect(getAgentRunContext(origin.runId)).not.toBe(originalContext);
        }
        const events = collect();

        await emitToolTurn(harness, fixture);

        expect(events).toEqual([]);
        // Update callbacks intentionally put item liveness before the raw tool callback.
        expect(onAgentEvent.mock.calls.map(([event]) => [event.stream, event.data.phase])).toEqual(
          expect.arrayContaining(fixture.phases),
        );
        expect(onAgentEvent).toHaveBeenCalledTimes(fixture.phases.length);
        expect(harness.subscription.getItemLifecycle()).toEqual({
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        });
      },
    );
  });

  it("captures registry routing when optional subscription owner fields are omitted", async () => {
    registerAgentRunContext(origin.runId, origin);
    const harness = subscribe({ agentId: undefined, sessionKey: undefined });
    clearAgentRunContext(origin.runId);
    const events = collect();

    await emitToolTurn(harness);

    expect(events).toHaveLength(fixtures[0].phases.length);
    for (const event of events) {
      expect(event).toMatchObject(origin);
    }
  });

  it("rechecks ownership after an awaited start flush", async () => {
    registerAgentRunContext(origin.runId, origin);
    const flush = createDeferredCore();
    const onBlockReplyFlush = vi.fn(() => flush.promise);
    const onAgentEvent = vi.fn();
    const harness = subscribe({ onBlockReplyFlush, onAgentEvent });
    const events = collect();
    startTool(harness, fixtures[0]);
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    clearAgentRunContext(origin.runId);
    registerAgentRunContext(origin.runId, replacement);
    flush.resolve();

    await finishTool(harness, fixtures[0]);

    expect(events).toEqual([]);
    expect(onAgentEvent).toHaveBeenCalledTimes(fixtures[0].phases.length);
  });

  it.each([true, false])(
    "rejects an unrelated retired execution scope for the same run (visible=%s)",
    async (visible) => {
      const generation = getAgentEventLifecycleGeneration();
      const harness = withAgentRunLifecycleGeneration(generation, () => {
        registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: visible });
        const subscribed = subscribe();
        clearAgentRunContext(origin.runId);
        return subscribed;
      });
      const events = collect();

      await withAgentRunLifecycleGeneration(generation, async () => {
        registerAgentRunContext(origin.runId, {
          ...replacement,
          isControlUiVisible: false,
          projectSessionMessages: true,
        });
        clearAgentRunContext(origin.runId);
        await emitToolTurn(harness);
      });

      expect(events).toEqual([]);
    },
  );

  it("does not promote a hidden subscription when the same registration becomes visible", async () => {
    registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
    const harness = subscribe();
    registerAgentRunContext(origin.runId, { isControlUiVisible: true });
    const events = collect();

    await emitToolTurn(harness);

    expect(events).toEqual([]);
  });

  it("preserves channel result delivery after hidden observer cleanup", async () => {
    registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
    const onToolResult = vi.fn();
    const harness = subscribe({ onToolResult, shouldEmitToolOutput: () => true });
    clearAgentRunContext(origin.runId);
    const events = collect();

    await emitToolTurn(harness, {
      name: "read",
      toolName: "read",
      args: { path: "fixture.txt" },
      result: textResult,
      phases: [],
    });

    expect(events).toEqual([]);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fixture-result") }),
    );
  });

  it("keeps throttled exec callbacks live without publishing stale observer updates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    registerAgentRunContext(origin.runId, origin);
    const onAgentEvent = vi.fn();
    const harness = subscribe({ onAgentEvent });
    const fixture = fixtures[1];
    startTool(harness, fixture);
    const update = {
      type: "tool_execution_update",
      toolName: fixture.toolName,
      toolCallId: "owned-tool",
      partialResult: fixture.partialResult,
    };
    harness.emit(update);
    await harness.subscription.waitForPendingEvents();
    clearAgentRunContext(origin.runId);
    registerAgentRunContext(origin.runId, replacement);
    onAgentEvent.mockClear();
    const events = collect();

    harness.emit(update);
    await harness.subscription.waitForPendingEvents();

    expect(events).toEqual([]);
    expect(onAgentEvent.mock.calls.map(([event]) => [event.stream, event.data.phase])).toEqual([
      ["item", "update"],
      ["tool", "update"],
    ]);
  });

  it("uses subscription ownership for the nested lifecycle runner", async () => {
    registerAgentRunContext(origin.runId, origin);
    const harness = subscribe();
    const events = collect();

    await harness.subscription.runToolLifecycle({
      toolName: "progress_card",
      toolCallId: "nested-owned-tool",
      args: fixtures[0].args,
      execute: async (onImplementationStart) => {
        onImplementationStart();
        clearAgentRunContext(origin.runId);
        return textResult;
      },
    });

    expect(events.map((event) => [event.stream, event.data.phase])).toEqual([
      ["item", "start"],
      ["tool", "start"],
      ["plan", "update"],
      ["tool", "result"],
      ["item", "end"],
    ]);
    for (const event of events) {
      expect(event).toMatchObject(origin);
    }
  });

  it("cannot bypass exclusive claim admission or revive a released owner token", async () => {
    const claimId = claimAgentRunContext(origin.runId, origin, {
      exclusive: true,
      trackOwner: true,
    });
    expect(claimId).toBeTypeOf("string");
    const harness = subscribe();
    const events = collect();

    await emitToolTurn(harness);
    expect(events).toEqual([]);
    const event = {
      ...origin,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      stream: "tool" as const,
      data: { phase: "result", toolCallId: "exclusive-owned-tool" },
    };
    expect(emitAgentEventForOwner(event, claimId!)).toBe(true);
    releaseAgentRunContext(origin.runId, claimId);
    expect(emitAgentEventForOwner(event, claimId!)).toBe(false);
    expect(events).toHaveLength(1);
  });
});
