import type { PluginHookToolRequesterContext } from "../plugins/hook-types.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

export function resolveCodingToolsCapabilityProfile(
  options?: OpenClawCodingToolsOptions,
  sandbox?: OpenClawCodingToolsOptions["sandbox"],
) {
  const capabilityProfile =
    options?.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      config: options?.config,
      sessionKey: options?.sessionKey,
      runSessionKey: options?.runSessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      agentId: options?.policyAgentId ?? options?.agentId,
      agentDir: options?.agentDir,
      agentAccountId: options?.agentAccountId,
      messageProvider: options?.messageProvider,
      messageChannel: options?.messageChannel,
      chatType: options?.chatType,
      messageTo: options?.messageTo,
      messageThreadId: options?.messageThreadId,
      conversationToolPolicy: options?.conversationToolPolicy,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
      currentThreadTs: options?.currentThreadTs,
      currentMessageId: options?.currentMessageId,
      groupId: options?.groupId,
      groupChannel: options?.groupChannel,
      groupSpace: options?.groupSpace,
      memberRoleIds: options?.memberRoleIds,
      spawnedBy: options?.spawnedBy,
      senderId: options?.senderId,
      senderName: options?.senderName,
      senderUsername: options?.senderUsername,
      senderE164: options?.senderE164,
      senderIsOwner: options?.senderIsOwner,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      modelContextWindowTokens: options?.modelContextWindowTokens,
      modelHasVision: options?.modelHasVision,
      workspaceDir: options?.workspaceDir,
      cwd: options?.cwd,
      spawnWorkspaceDir: options?.spawnWorkspaceDir,
      skillsSnapshot: options?.skillsSnapshot,
      sandboxToolPolicy: sandbox?.tools,
      runtimeToolAllowlist: options?.runtimeToolAllowlist,
      inheritRuntimeToolAllowlist: options?.inheritRuntimeToolAllowlist,
      inputProvenance: options?.inputProvenance,
      trustedInternalHandoff: options?.trustedInternalHandoff,
      scheduledToolPolicy: options?.scheduledToolPolicy,
      pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    });
  return capabilityProfile;
}

/** Project prepared execution identity without borrowing the policy owner's authority. */
export function createCodingToolsHookContext(params: {
  options?: OpenClawCodingToolsOptions;
  policyAgentId?: string;
  executionAgentId?: string;
  executionSessionKey?: string;
  codingRoot: string;
  workspaceRoot: string;
  sandbox?: HookContext["sandbox"];
}): HookContext {
  const {
    options,
    policyAgentId,
    executionAgentId,
    executionSessionKey,
    codingRoot,
    workspaceRoot,
    sandbox,
  } = params;
  const turnSourceChannel = options?.messageChannel ?? options?.messageProvider;
  const turnSourceTo = options?.currentMessagingTarget ?? options?.currentChannelId;
  const requester = {
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(options?.agentAccountId ? { accountId: options.agentAccountId } : {}),
    ...(options?.senderId ? { senderId: options.senderId } : {}),
    ...(options?.senderIsOwner !== undefined ? { senderIsOwner: options.senderIsOwner } : {}),
    ...(options?.memberRoleIds?.length ? { roleIds: [...options.memberRoleIds] } : {}),
  } satisfies PluginHookToolRequesterContext;
  const hasRequester = Object.keys(requester).length > 0;
  const hookContext = {
    agentId: executionAgentId,
    ...(options?.config ? { config: options.config } : {}),
    cwd: codingRoot,
    workspaceDir: workspaceRoot,
    ...(options?.skillsSnapshot ? { skillsSnapshot: options.skillsSnapshot } : {}),
    ...(options?.skillUsagePaths ? { skillUsagePaths: options.skillUsagePaths } : {}),
    ...(sandbox ? { sandbox } : {}),
    sessionKey: executionSessionKey,
    sessionId: options?.sessionId,
    runId: options?.runId,
    trigger: options?.trigger,
    approvalReviewerDeviceId: options?.approvalReviewerDeviceId,
    channelId: options?.hookChannelId ?? options?.currentChannelId,
    ...(hasRequester ? { requester } : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(options?.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
    ...(options?.currentThreadTs ? { turnSourceThreadId: options.currentThreadTs } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId: policyAgentId }),
    onToolOutcome: options?.onToolOutcome,
    allocateToolOutcomeOrdinal: options?.allocateToolOutcomeOrdinal,
  };
  return hookContext;
}
