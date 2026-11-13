import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import {
  collectErrorGraphCandidates,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readQueuedDeliveryEntriesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../channel.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { MatrixClient } from "./sdk.js";
import { MatrixSendScheduler } from "./sdk/send-scheduler.js";
import { sendMessageMatrix } from "./send.js";
import type { MatrixSendOpts } from "./send/types.js";

describe("Matrix missing relation delivery", () => {
  it.each([
    { liveOnly: true, terminal: true, concurrent: false },
    { liveOnly: false, terminal: true, concurrent: false },
    { liveOnly: true, terminal: false, concurrent: false },
    { liveOnly: false, terminal: true, concurrent: true },
  ])(
    "preserves rejection semantics (liveOnly=$liveOnly, terminal=$terminal, concurrent=$concurrent)",
    async ({ liveOnly, terminal, concurrent }) => {
      const errorMessage = terminal ? "Can't send relation to unknown event" : "Unrelated failure";
      await withOpenClawTestState({ prefix: "matrix-missing-relation-" }, async ({ stateDir }) => {
        installMatrixTestRuntime({ stateDir });
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
        );
        const requests: Array<{ path: string; body: unknown }> = [];
        const requestErrors: unknown[] = [];
        const receipts: unknown[] = [];
        const siblingReceipts: unknown[] = [];
        const firstStarted = createDeferred<void>();
        const siblingQueued = createDeferred<void>();
        // oxlint-disable-next-line typescript/unbound-method -- call preserves the intercepted scheduler receiver below.
        const queueEvent = MatrixSendScheduler.prototype.queueEvent;
        // Hold the server rejection until the valid sibling is in the real SDK queue.
        const queueSpy = concurrent
          ? vi.spyOn(MatrixSendScheduler.prototype, "queueEvent").mockImplementation(function (
              this: MatrixSendScheduler,
              event,
            ) {
              const queued = queueEvent.call(this, event);
              if (event.getRoomId() === "!other:example.org") {
                siblingQueued.resolve();
              }
              return queued;
            })
          : undefined;
        try {
          await withServer(
            (request, response) => {
              void (async () => {
                const path = decodeURIComponent(request.url ?? "");
                response.setHeader("content-type", "application/json");
                if (path.includes("/state/m.room.encryption")) {
                  response.writeHead(404);
                  response.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "unencrypted" }));
                } else if (path.includes("/account/whoami")) {
                  response.end(
                    JSON.stringify({ user_id: "@bot:example.org", device_id: "fixture" }),
                  );
                } else if (request.method === "PUT" && path.includes("/send/m.room.message/")) {
                  const chunks: Buffer[] = [];
                  for await (const chunk of request) {
                    chunks.push(Buffer.from(chunk));
                  }
                  requests.push({ path, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
                  if (path.includes("/rooms/!other:example.org/")) {
                    response.end(JSON.stringify({ event_id: "$ValidMessage" }));
                    return;
                  }
                  firstStarted.resolve();
                  if (concurrent) {
                    await siblingQueued.promise;
                  }
                  response.writeHead(400);
                  response.end(JSON.stringify({ errcode: "M_UNKNOWN", error: errorMessage }));
                } else {
                  throw new Error(`Unexpected Matrix fixture request: ${request.method} ${path}`);
                }
              })().catch((error: unknown) => {
                requestErrors.push(error);
                response.writeHead(500);
                response.end(JSON.stringify({ errcode: "M_UNKNOWN", error: "fixture failure" }));
              });
            },
            async (baseUrl) => {
              const client = new MatrixClient(baseUrl, "fixture-token", {
                userId: "@bot:example.org",
                deviceId: "fixture",
                encryption: false,
                autoBootstrapCrypto: false,
                ssrfPolicy: { allowPrivateNetwork: true },
              });
              const cfg = { channels: { matrix: { enabled: true } } };
              try {
                const sendParams: Parameters<typeof sendDurableMessageBatch>[0] = {
                  cfg,
                  channel: "matrix",
                  accountId: "default",
                  to: "!room:example.org",
                  threadId: "$MissingThreadRoot",
                  payloads: [{ text: "Restart recovery notice" }],
                  skipQueue: liveOnly,
                  bestEffort: true,
                  ...(!liveOnly ? { deliveryIntentId: "missing-relation-notice" } : {}),
                  deps: {
                    matrix: (to: string, text: string | undefined, options: MatrixSendOpts) =>
                      sendMessageMatrix(to, text, { ...options, client }),
                  },
                  onDeliveryResult: (receipt) => {
                    receipts.push(receipt);
                  },
                };
                const rejectedDelivery = sendDurableMessageBatch(sendParams);
                if (concurrent) {
                  await Promise.race([
                    firstStarted.promise,
                    rejectedDelivery.then((result) => {
                      throw new Error("Matrix fixture delivery settled before its PUT", {
                        cause: result,
                      });
                    }),
                  ]);
                }
                const validDelivery = concurrent
                  ? sendDurableMessageBatch({
                      ...sendParams,
                      to: "!other:example.org",
                      threadId: undefined,
                      payloads: [{ text: "Valid concurrent message" }],
                      deliveryIntentId: "valid-concurrent-message",
                      onDeliveryResult: (receipt) => {
                        siblingReceipts.push(receipt);
                      },
                    })
                  : undefined;
                void validDelivery?.then(
                  () => siblingQueued.resolve(),
                  (error: unknown) => siblingQueued.reject(error),
                );
                const result = await rejectedDelivery;
                if (concurrent) {
                  expect(await validDelivery).toMatchObject({ status: "sent" });
                  expect(siblingReceipts).toHaveLength(1);
                }
                if (result.status === "failed" && !result.payloadOutcomes) {
                  throw result.error;
                }
                expect(result).toMatchObject({ status: "failed" });
                expect(result.payloadOutcomes?.[0]).toMatchObject({
                  status: "failed",
                  sentBeforeError: !terminal,
                });
                const outcome = result.payloadOutcomes?.[0];
                if (outcome?.status !== "failed") {
                  throw new Error("Missing failed payload outcome");
                }
                const rejection = collectErrorGraphCandidates(outcome.error, (error) => [
                  error.cause,
                ]).find((error) => error instanceof PlatformMessageNotDispatchedError);
                if (terminal) {
                  expect(rejection).toMatchObject({ retryable: false });
                } else {
                  expect(rejection).toBeUndefined();
                  expect(outcome.error).toMatchObject({ httpStatus: 400, error: errorMessage });
                }
                expect(readQueuedDeliveryEntriesForTest(stateDir)).toEqual([]);
                await drainPendingDeliveries({
                  cfg,
                  stateDir,
                  drainKey: "matrix-missing-relation",
                  logLabel: "Matrix missing relation",
                  log: { info() {}, warn() {}, error() {} },
                  selectEntry: () => ({ match: true, bypassBackoff: true }),
                });
                expect(requests).toHaveLength(concurrent ? 2 : 1);
                expect(requests[0]).toMatchObject({
                  path: expect.stringContaining("/rooms/!room:example.org/send/m.room.message/"),
                  body: {
                    "m.relates_to": { rel_type: "m.thread", event_id: "$MissingThreadRoot" },
                  },
                });
                if (concurrent) {
                  expect(requests[1]).toMatchObject({
                    path: expect.stringContaining("/rooms/!other:example.org/send/m.room.message/"),
                    body: { body: "Valid concurrent message" },
                  });
                }
                expect(receipts).toEqual([]);
                expect(requestErrors).toEqual([]);
              } finally {
                siblingQueued.resolve();
                await client.stopWithoutPersist();
              }
            },
          );
        } finally {
          queueSpy?.mockRestore();
          resetPluginRuntimeStateForTest();
        }
      });
    },
  );
});
