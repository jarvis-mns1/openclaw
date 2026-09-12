import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
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

function isToolOrPlan(event: AgentEventRuntimePayload) {
  return event.stream === "tool" || event.stream === "plan";
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

      expect(events.filter(isToolOrPlan)).toEqual([]);
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

    expect(events.filter(isToolOrPlan)).toEqual([]);
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

    expect(events.filter(isToolOrPlan)).toEqual([]);
  });

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
    expect(events.filter(isToolOrPlan)).toEqual([]);
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
});
