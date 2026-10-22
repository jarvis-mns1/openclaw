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
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

const origin = {
  runId: "tool-origin-run",
  sessionKey: "agent:work:original",
  agentId: "work",
};

type SubscriptionHarness = ReturnType<typeof createSubscribedSessionHarness>;

async function emitToolTurn(harness: SubscriptionHarness, toolName = "progress_card") {
  const args =
    toolName === "progress_card"
      ? { markdown: "Inspecting", plan: [{ step: "Inspect", status: "in_progress" }] }
      : { path: "fixture.txt" };
  const toolCallId = `${toolName}-owned`;
  harness.emit({ type: "tool_execution_start", toolName, toolCallId, args });
  harness.emit({
    type: "tool_execution_update",
    toolName,
    toolCallId,
    args,
    partialResult: { content: [{ type: "text", text: "fixture-progress" }] },
  });
  harness.emit({
    type: "tool_execution_end",
    toolName,
    toolCallId,
    isError: false,
    result: { content: [{ type: "text", text: "fixture-result" }] },
  });
  await harness.subscription.waitForPendingEvents();
}

const typedActivityStreams = ["command_output", "approval", "patch"] as const;

async function emitTypedToolTurn(
  harness: SubscriptionHarness,
  stream: (typeof typedActivityStreams)[number],
) {
  const toolName = stream === "patch" ? "apply_patch" : "exec";
  const toolCallId = `${stream}-owned`;
  const args =
    stream === "patch" ? { patch: "*** Begin Patch" } : { command: "printf fixture-output" };
  const details =
    stream === "patch"
      ? { summary: { added: ["added.ts"], modified: ["modified.ts"], deleted: ["deleted.ts"] } }
      : stream === "approval"
        ? {
            status: "approval-pending",
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            command: "printf fixture-output",
            cwd: "/tmp/work",
          }
        : { status: "completed", aggregated: "fixture-output", exitCode: 0, durationMs: 12 };
  harness.emit({ type: "tool_execution_start", toolName, toolCallId, args });
  if (stream === "command_output") {
    harness.emit({
      type: "tool_execution_update",
      toolName,
      toolCallId,
      args,
      partialResult: {
        content: [{ type: "text", text: "fixture-output" }],
        details: { status: "running", aggregated: "fixture-output" },
      },
    });
  }
  harness.emit({
    type: "tool_execution_end",
    toolName,
    toolCallId,
    isError: false,
    result: { content: [{ type: "text", text: "fixture-result" }], details },
  });
  await harness.subscription.waitForPendingEvents();
}

function isToolOrPlan(event: AgentEventRuntimePayload) {
  return event.stream === "tool" || event.stream === "plan";
}

function isToolActivity(event: AgentEventRuntimePayload) {
  return ["tool", "plan", "item", "command_output", "approval", "patch"].includes(event.stream);
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

  describe.each(typedActivityStreams)("%s ownership", (stream) => {
    it.each(["clear", "release"] as const)(
      "preserves typed owner identity after context %s",
      async (cleanup) => {
        const claimId = claimAgentRunContext(origin.runId, origin, {
          trackOwner: true,
          ownsContext: true,
        });
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const harness = subscribe();
        if (cleanup === "clear") {
          clearAgentRunContext(origin.runId);
        }
        releaseAgentRunContext(origin.runId, claimId);
        expect(getAgentRunContext(origin.runId)).toBeUndefined();
        registerAgentRunContext("replacement-run", {
          agentId: "main",
          sessionKey: "agent:main:replacement",
        });
        const events = collect();

        await emitTypedToolTurn(harness, stream);

        const owned = events.filter(isToolActivity);
        expect(owned.map((event) => event.stream)).toEqual(
          expect.arrayContaining(["tool", "item", stream]),
        );
        for (const event of owned) {
          expect(event).toMatchObject({ ...origin, lifecycleGeneration });
        }
      },
    );

    it("preserves hidden visibility on every typed event before cleanup", async () => {
      registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
      const harness = subscribe();
      const events = collect();

      await emitTypedToolTurn(harness, stream);

      const owned = events.filter(isToolActivity);
      expect(owned.map((event) => event.stream)).toEqual(
        expect.arrayContaining(["tool", "item", stream]),
      );
      for (const event of owned) {
        expect(event.runId).toBe(origin.runId);
        expect(event.agentId).toBe(origin.agentId);
        expect(event.controlUiVisible).toBe(false);
        expect(event.sessionKey).toBeUndefined();
        expect(Object.keys(event)).not.toContain("controlUiVisible");
      }
      clearAgentRunContext(origin.runId);
    });

    it.each(["hidden-clear", "visible-replacement", "hidden-replacement", "rotation"] as const)(
      "rejects stale typed observer events after %s while preserving callbacks",
      async (cleanup) => {
        registerAgentRunContext(origin.runId, {
          ...origin,
          isControlUiVisible: cleanup !== "hidden-clear",
        });
        const onAgentEvent = vi.fn();
        const harness = subscribe({ onAgentEvent });
        clearAgentRunContext(origin.runId);
        if (cleanup !== "hidden-clear") {
          const lifecycleGeneration =
            cleanup === "rotation"
              ? rotateAgentEventLifecycleGeneration()
              : getAgentEventLifecycleGeneration();
          registerAgentRunContext(origin.runId, {
            agentId: "main",
            sessionKey: "agent:main:replacement",
            isControlUiVisible: cleanup !== "hidden-replacement",
            lifecycleGeneration,
          });
        }
        const events = collect();

        await emitTypedToolTurn(harness, stream);

        expect(events.filter(isToolActivity)).toEqual([]);
        const callbacks = onAgentEvent.mock.calls.map(([event]) => event);
        expect(callbacks.map((event) => event.stream)).toEqual(
          expect.arrayContaining(["tool", "item", stream]),
        );
        expect(
          callbacks.filter((event) => event.stream === stream).map((event) => event.data.phase),
        ).toEqual(
          stream === "command_output"
            ? ["delta", "end"]
            : [stream === "approval" ? "requested" : "end"],
        );
      },
    );
  });

  it.each(["clear", "release"] as const)(
    "preserves originating tool and plan identity after context %s with another agent active",
    async (cleanup) => {
      const claimId = claimAgentRunContext(origin.runId, origin, {
        trackOwner: true,
        ownsContext: true,
      });
      const harness = subscribe();
      if (cleanup === "clear") {
        clearAgentRunContext(origin.runId);
      }
      releaseAgentRunContext(origin.runId, claimId);
      expect(getAgentRunContext(origin.runId)).toBeUndefined();
      registerAgentRunContext("replacement-run", {
        agentId: "main",
        sessionKey: "agent:main:replacement",
      });
      const events = collect();

      await emitToolTurn(harness);

      const owned = events.filter(isToolOrPlan);
      expect(owned.map((event) => [event.stream, event.data.phase])).toEqual([
        ["tool", "start"],
        ["tool", "update"],
        ["plan", "update"],
        ["tool", "result"],
      ]);
      for (const event of owned) {
        expect(event).toMatchObject(origin);
      }
    },
  );

  it.each(["clear", "visible-replacement"] as const)(
    "does not promote hidden tool and plan traffic after %s before emission",
    async (cleanup) => {
      registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
      const onAgentEvent = vi.fn();
      const harness = subscribe({ onAgentEvent });
      clearAgentRunContext(origin.runId);
      if (cleanup === "visible-replacement") {
        registerAgentRunContext(origin.runId, {
          agentId: "main",
          sessionKey: "agent:main:replacement",
          isControlUiVisible: true,
        });
      }
      const events = collect();

      await emitToolTurn(harness);

      expect(events.filter(isToolActivity)).toEqual([]);
      expect(onAgentEvent.mock.calls.map(([event]) => [event.stream, event.data.phase])).toEqual(
        expect.arrayContaining([
          ["tool", "start"],
          ["tool", "update"],
          ["plan", "update"],
          ["tool", "result"],
        ]),
      );
    },
  );

  it("keeps hidden metadata on tool and plan events emitted before context cleanup", async () => {
    registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
    const harness = subscribe();
    const events = collect();

    await emitToolTurn(harness);
    clearAgentRunContext(origin.runId);

    const owned = events.filter(isToolOrPlan);
    expect(owned).toHaveLength(4);
    for (const event of owned) {
      expect(event.controlUiVisible).toBe(false);
      expect(event.sessionKey).toBeUndefined();
      expect(event.agentId).toBe(origin.agentId);
      expect(Object.keys(event)).not.toContain("controlUiVisible");
    }
  });

  it("preserves authorized channel tool delivery after hidden observer cleanup", async () => {
    registerAgentRunContext(origin.runId, { ...origin, isControlUiVisible: false });
    const onToolResult = vi.fn();
    const harness = subscribe({
      onToolResult,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
    });
    clearAgentRunContext(origin.runId);
    const events = collect();

    await emitToolTurn(harness, "read");

    expect(events.filter(isToolActivity)).toEqual([]);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fixture-result") }),
    );
  });

  it("rejects old subscription tool and plan events after lifecycle rotation without async context", async () => {
    registerAgentRunContext(origin.runId, origin);
    const harness = subscribe();
    const lifecycleGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext(origin.runId, {
      agentId: "main",
      sessionKey: "agent:main:replacement",
      lifecycleGeneration,
    });
    expect(getAgentRunContext(origin.runId)?.lifecycleGeneration).toBe(lifecycleGeneration);
    const events = collect();

    await emitToolTurn(harness);

    expect(events.filter(isToolActivity)).toEqual([]);
  });

  it.each([true, false])(
    "rejects a replacement registration in the same generation (visible=%s)",
    async (visible) => {
      registerAgentRunContext(origin.runId, origin);
      const originalContext = getAgentRunContext(origin.runId);
      const harness = subscribe();
      clearAgentRunContext(origin.runId);
      registerAgentRunContext(origin.runId, {
        agentId: "main",
        sessionKey: "agent:main:replacement",
        isControlUiVisible: visible,
      });
      expect(getAgentRunContext(origin.runId)).not.toBe(originalContext);
      expect(getAgentRunContext(origin.runId)?.lifecycleGeneration).toBe(
        originalContext?.lifecycleGeneration,
      );
      const events = collect();

      await emitToolTurn(harness);

      expect(events.filter(isToolActivity)).toEqual([]);
    },
  );

  it("cannot bypass an exclusive owner or revive its released owner-token events", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claimId = claimAgentRunContext(origin.runId, origin, {
      exclusive: true,
      trackOwner: true,
    });
    expect(claimId).toBeTypeOf("string");
    const harness = subscribe();
    const events = collect();

    await emitToolTurn(harness);
    expect(events.filter(isToolActivity)).toEqual([]);
    const event = {
      ...origin,
      lifecycleGeneration,
      stream: "tool" as const,
      data: { phase: "result", toolCallId: "owned-claim" },
    };
    emitAgentEventForOwner(event, claimId!);
    expect(events.filter(isToolOrPlan)).toHaveLength(1);
    releaseAgentRunContext(origin.runId, claimId);
    emitAgentEventForOwner(event, claimId!);
    expect(events.filter(isToolOrPlan)).toHaveLength(1);
  });

  it.each([true, false])(
    "rejects another retired execution scope for the same run (visible=%s)",
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
          agentId: "main",
          sessionKey: "agent:main:replacement",
          isControlUiVisible: false,
          projectSessionMessages: true,
        });
        clearAgentRunContext(origin.runId);
        await emitToolTurn(harness);
      });
      expect(events.filter(isToolActivity)).toEqual([]);
    },
  );
});
