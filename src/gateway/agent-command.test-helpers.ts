// Gateway agent-command test helpers.
// Waits for mocked agent command dispatches in async gateway tests.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sleep } from "../utils/sleep.js";
import { waitForFast } from "./client.test-support.js";
import { agentCommandMock, testState } from "./test-helpers.runtime-state.js";

type AgentCommandCall = Record<string, unknown>;

async function observeRunCompletion(runId: string, method: "agent" | "chat.send") {
  const executionModule =
    method === "agent" ? await import("./agent-turn/agent-run-execution-phase.js") : undefined;
  const admission = await import("../process/gateway-work-admission.js");
  const requests = await import("./server-methods.js");
  const execute = executionModule?.startAgentRunExecution;
  const retain = admission.runWithRetainedGatewayRootWork;
  const retainContinuation = admission.retainGatewayRootWorkAdmissionContinuation;
  const handle = requests.handleGatewayRequest;
  const requestContext = new AsyncLocalStorage<string>();
  const operationCompleted = createDeferred();
  const pending = new Set<Promise<unknown>>();
  const observe = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    const forget = () => pending.delete(promise);
    void promise.then(forget, forget);
    return promise;
  };
  const joinObservedWork = async () => {
    // Participant persistence can publish another retained effect while settling.
    while (pending.size > 0) {
      await Promise.allSettled(pending);
    }
  };
  const continuationObserver = vi
    .spyOn(admission, "retainGatewayRootWorkAdmissionContinuation")
    .mockImplementation(() => {
      const release = retainContinuation();
      if (!release || requestContext.getStore() !== runId) {
        return release;
      }
      const released = createDeferred();
      void observe(released.promise);
      return () => {
        release();
        released.resolve();
      };
    });
  const retainedObserver = vi
    .spyOn(admission, "runWithRetainedGatewayRootWork")
    .mockImplementation((run) => {
      const belongsToRequest =
        requestContext.getStore() === runId &&
        admission.getActiveGatewayRootWorkCount() >
          admission.getActiveGatewayRootWorkCount({ excludeCurrent: true });
      const promise = retain(run);
      return belongsToRequest ? observe(promise) : promise;
    });
  const requestObserver = vi
    .spyOn(requests, "handleGatewayRequest")
    .mockImplementation((params, diagnostics) => {
      if (
        params.req.method !== method ||
        !isRecord(params.req.params) ||
        params.req.params.idempotencyKey !== runId
      ) {
        return handle(params, diagnostics);
      }
      const request = requestContext.run(runId, () => observe(handle(params, diagnostics)));
      if (method === "chat.send") {
        operationCompleted.resolve(request);
      }
      return request;
    });
  const completed = operationCompleted.promise.then(joinObservedWork);
  // A failed RPC can leave the test before it awaits the execution result.
  void completed.catch(() => {});
  const executionObserver =
    executionModule && execute
      ? vi.spyOn(executionModule, "startAgentRunExecution").mockImplementation((params) => {
          const execution = execute(params);
          if (params.runId === runId && requestContext.getStore() === runId) {
            operationCompleted.resolve(observe(execution));
          }
          return execution;
        })
      : undefined;
  return {
    completed,
    join: joinObservedWork,
    async [Symbol.asyncDispose]() {
      try {
        await joinObservedWork();
      } finally {
        executionObserver?.mockRestore();
        requestObserver.mockRestore();
        retainedObserver.mockRestore();
        continuationObserver.mockRestore();
        requestContext.disable();
      }
    },
  };
}

/** Join one real agent RPC, its execution, and its root-retained effects. */
export const observeAgentRunCompletion = (runId: string) => observeRunCompletion(runId, "agent");

/** Join one real chat RPC and its detached dispatch's native retained work. */
export const observeChatRunCompletion = (runId: string) => observeRunCompletion(runId, "chat.send");

/** Keep a selected synthetic session store alive through its admitted request work. */
export async function withMainSessionStore<T>(
  run: (dir: string) => Promise<T>,
  options?: { archivedAt?: number; sessionId?: string; settleRequest?: () => Promise<void> },
): Promise<T> {
  const { getActiveGatewayRootWorkCount } = await import("../process/gateway-work-admission.js");
  const { writeSessionStore } = await import("./test-helpers.server.js");
  const { removeChatTestDirectory } = await import("./session-test-directories.test-support.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
  try {
    const sessionId = options?.sessionId ?? "sess-main";
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          sessionFile: path.join(dir, `${sessionId}.jsonl`),
          updatedAt: Date.now(),
          ...(options?.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
        },
      },
    });
    return await run(dir);
  } finally {
    // Dispatch can outlive its RPC; keep its store selected until retained work settles.
    await options?.settleRequest?.();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    testState.sessionStorePath = undefined;
    await removeChatTestDirectory(dir);
  }
}

function agentCommandCalls(): Array<[AgentCommandCall]> {
  return vi.mocked(agentCommandMock).mock.calls as unknown as Array<[AgentCommandCall]>;
}

/** Waits until the mocked `agentCommand` receives a call for a specific run id. */
export async function waitForAgentCommandCall(runId: string): Promise<AgentCommandCall> {
  for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) {
    const call = agentCommandCalls()
      .map((entry) => entry[0])
      .find((entry) => entry.runId === runId);
    if (call) {
      return call;
    }
    await sleep(5);
  }
  throw new Error(`expected agentCommand to be called for ${runId}`);
}

/** Reads the latest mocked `agentCommand` call, or waits for a specific run id. */
export async function readAgentCommandCall(
  params: { runId?: string; fromEnd?: number } = {},
): Promise<AgentCommandCall> {
  if (params.runId) {
    return await waitForAgentCommandCall(params.runId);
  }
  return agentCommandCalls().at(-(params.fromEnd ?? 1))?.[0] ?? {};
}
