import { describe, expect, it } from "vitest";
import {
  createCodingToolsHookContext,
  resolveCodingToolsCapabilityProfile,
} from "./agent-tools.context.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

describe("coding tool prepared context", () => {
  it("reuses an already prepared capability profile without resolving it for another owner", () => {
    const profile = resolveConversationCapabilityProfile({ agentId: "policy-owner" });
    expect(
      resolveCodingToolsCapabilityProfile({
        agentId: "execution-owner",
        conversationCapabilityProfile: profile,
      }),
    ).toBe(profile);
  });

  it("uses execution identity for hooks and the policy owner only for loop configuration", () => {
    const roleIds = ["operator"];
    const context = createCodingToolsHookContext({
      options: {
        config: {
          agents: {
            list: [
              { id: "policy-owner", tools: { loopDetection: { enabled: true } } },
              { id: "execution-owner", tools: { loopDetection: { enabled: false } } },
            ],
          },
        },
        sessionId: "session-current",
        runId: "run-current",
        messageChannel: "discord",
        messageProvider: "telegram",
        currentMessagingTarget: "current-target",
        currentChannelId: "channel-fallback",
        hookChannelId: "hook-channel",
        agentAccountId: "operations",
        currentThreadTs: "thread-current",
        senderId: "requester",
        senderIsOwner: false,
        memberRoleIds: roleIds,
      },
      policyAgentId: "policy-owner",
      executionAgentId: "execution-owner",
      executionSessionKey: "agent:execution-owner:current",
      codingRoot: "/synthetic/cwd",
      workspaceRoot: "/synthetic/workspace",
    });
    roleIds.push("late-role");
    expect(context).toMatchObject({
      agentId: "execution-owner",
      sessionKey: "agent:execution-owner:current",
      sessionId: "session-current",
      runId: "run-current",
      cwd: "/synthetic/cwd",
      workspaceDir: "/synthetic/workspace",
      channelId: "hook-channel",
      turnSourceChannel: "discord",
      turnSourceTo: "current-target",
      turnSourceAccountId: "operations",
      turnSourceThreadId: "thread-current",
      loopDetection: { enabled: true },
      requester: {
        channel: "discord",
        accountId: "operations",
        senderId: "requester",
        senderIsOwner: false,
        roleIds: ["operator"],
      },
    });
  });

  it.each([false, true])(
    "forwards only prepared sandbox authority (present=%s) without inventing requester facts",
    (present) => {
      const root = "/synthetic/sandbox";
      const bridge = createHostSandboxFsBridge(root);
      const context = createCodingToolsHookContext({
        codingRoot: root,
        workspaceRoot: "/synthetic/workspace",
        sandbox: present ? { root, bridge } : undefined,
      });
      expect(context.sandbox).toEqual(present ? { root, bridge } : undefined);
      expect(context).not.toHaveProperty("requester");
    },
  );
});
