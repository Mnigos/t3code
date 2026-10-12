import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  resolveLatestProviderVersion,
  type ProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

type Reply = { readonly status: number; readonly version?: string } | "hang";

const capabilities = (packageName: string): ProviderMaintenanceCapabilities => ({
  provider: ProviderDriverKind.make("packageTool"),
  packageName,
  update: null,
});
const toolA = capabilities("@example/tool-a");
const toolB = capabilities("@example/tool-b");

/** An npm registry stand-in that records which packages were requested. */
function makeRegistry() {
  const requests: Array<string> = [];
  const replies = new Map<string, Reply>();
  const client = HttpClient.make((request) => {
    const packageName = decodeURIComponent(new URL(request.url).pathname.split("/")[1]!);
    requests.push(packageName);
    const reply = replies.get(packageName) ?? { status: 404 };
    if (reply === "hang") return Effect.never;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ version: reply.version }), { status: reply.status }),
      ),
    );
  });
  const layerTest = Layer.mergeAll(
    ProviderLatestVersions.layer,
    Layer.succeed(HttpClient.HttpClient, client),
  );
  const requestCount = (packageName: string) =>
    requests.filter((requested) => requested === packageName).length;
  return { layerTest, replies, requestCount };
}

it.effect("caches a found version for an hour", () => {
  const registry = makeRegistry();
  registry.replies.set("@example/tool-a", { status: 200, version: "2.0.0" });
  return Effect.gen(function* () {
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    registry.replies.set("@example/tool-a", { status: 200, version: "2.1.0" });
    yield* TestClock.adjust("59 minutes");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    yield* TestClock.adjust("2 minutes");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.1.0");
    expect(registry.requestCount("@example/tool-a")).toBe(2);
  }).pipe(Effect.provide(registry.layerTest));
});

it.effect("retries a non-2xx lookup after a minute and keeps the later success", () => {
  const registry = makeRegistry();
  registry.replies.set("@example/tool-a", { status: 503 });
  return Effect.gen(function* () {
    expect(yield* resolveLatestProviderVersion(toolA)).toBeNull();
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    registry.replies.set("@example/tool-a", { status: 200, version: "2.0.0" });
    yield* TestClock.adjust("59 seconds");
    expect(yield* resolveLatestProviderVersion(toolA)).toBeNull();
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    yield* TestClock.adjust("2 seconds");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(2);

    // The success replaced the miss, so it now holds for the hour.
    yield* TestClock.adjust("30 minutes");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(2);
  }).pipe(Effect.provide(registry.layerTest));
});

it.effect("retries a timed-out lookup a minute after it started", () => {
  const registry = makeRegistry();
  registry.replies.set("@example/tool-a", "hang");
  return Effect.gen(function* () {
    const lookup = yield* resolveLatestProviderVersion(toolA).pipe(Effect.forkChild);
    yield* TestClock.adjust("4 seconds");
    expect(yield* Fiber.join(lookup)).toBeNull();
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    registry.replies.set("@example/tool-a", { status: 200, version: "2.0.0" });
    yield* TestClock.adjust("55 seconds");
    expect(yield* resolveLatestProviderVersion(toolA)).toBeNull();
    expect(registry.requestCount("@example/tool-a")).toBe(1);

    yield* TestClock.adjust("2 seconds");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(2);
  }).pipe(Effect.provide(registry.layerTest));
});

it.effect("keeps a separate entry per package", () => {
  const registry = makeRegistry();
  registry.replies.set("@example/tool-a", { status: 200, version: "2.0.0" });
  registry.replies.set("@example/tool-b", { status: 503 });
  return Effect.gen(function* () {
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(yield* resolveLatestProviderVersion(toolB)).toBeNull();

    registry.replies.set("@example/tool-b", { status: 200, version: "5.0.0" });
    yield* TestClock.adjust("61 seconds");
    expect(yield* resolveLatestProviderVersion(toolA)).toBe("2.0.0");
    expect(yield* resolveLatestProviderVersion(toolB)).toBe("5.0.0");
    expect(registry.requestCount("@example/tool-a")).toBe(1);
    expect(registry.requestCount("@example/tool-b")).toBe(2);
  }).pipe(Effect.provide(registry.layerTest));
});
