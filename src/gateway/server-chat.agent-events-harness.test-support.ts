import { vi } from "vitest";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  type AgentEventHandlerOptions,
} from "./server-chat.js";

export function createAgentEventHarnessFactory(
  dependencies: Pick<
    AgentEventHandlerOptions,
    "loadGatewaySessionLifecycleSnapshotForEvent" | "persistGatewaySessionLifecycleEventForEvent"
  >,
) {
  const {
    loadGatewaySessionLifecycleSnapshotForEvent: loadGatewaySessionLifecycleSnapshotMock,
    persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
  } = dependencies;
  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string, options?: { agentId?: string }) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
    clearTrackedActiveRun?: AgentEventHandlerOptions["clearTrackedActiveRun"];
    settleTrackedTerminal?: AgentEventHandlerOptions["settleTrackedTerminal"];
    trackTrackedRunTerminalPersistence?: AgentEventHandlerOptions["trackTrackedRunTerminalPersistence"];
    resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
    updateRunToolErrorSummary?: AgentEventHandlerOptions["updateRunToolErrorSummary"];
    resolveSessionActiveRunState?: AgentEventHandlerOptions["resolveSessionActiveRunState"];
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const nodeHasSessionSubscribers = vi.fn(() => true);
    const clearAgentRunContext = vi.fn();
    const clearTrackedActiveRun =
      vi.fn<NonNullable<AgentEventHandlerOptions["clearTrackedActiveRun"]>>();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = chatRunState.toolEventRecipients;
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeHasSessionSubscribers,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      loadGatewaySessionLifecycleSnapshotForEvent: loadGatewaySessionLifecycleSnapshotMock,
      persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
      isChatSendRunActive: params?.isChatSendRunActive,
      clearTrackedActiveRun: params?.clearTrackedActiveRun ?? clearTrackedActiveRun,
      settleTrackedTerminal: params?.settleTrackedTerminal,
      trackTrackedRunTerminalPersistence: params?.trackTrackedRunTerminalPersistence,
      resolveActiveLifecycleGenerationForRun: params?.resolveActiveLifecycleGenerationForRun,
      updateRunToolErrorSummary: params?.updateRunToolErrorSummary,
      resolveSessionActiveRunState: params?.resolveSessionActiveRunState,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeHasSessionSubscribers,
      clearAgentRunContext,
      clearTrackedActiveRun,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      handler,
    };
  }

  return createHarness;
}

type AgentEventHarness = ReturnType<ReturnType<typeof createAgentEventHarnessFactory>>;

export function emitRun1AssistantText(
  harness: AgentEventHarness,
  text: string,
  field: "text" | "delta" = "text",
  managedMediaUrls?: string[],
): AgentEventHarness {
  registerChatRun(harness.chatRunState, "run-1", "session-1", "client-1");
  emitAgentEvent(harness.handler, "run-1", "assistant", {
    [field]: text,
    ...(managedMediaUrls ? { managedMediaUrls } : {}),
  });
  return harness;
}

export function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter(([event]) => event === "chat");
}

export function chatDeltaTexts(broadcast: ReturnType<typeof vi.fn>) {
  return chatBroadcastCalls(broadcast)
    .map(([, payload]) => payload as { state?: string; deltaText?: string })
    .filter((payload) => payload.state === "delta")
    .map((payload) => payload.deltaText);
}

export function agentBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter(([event]) => event === "agent");
}
