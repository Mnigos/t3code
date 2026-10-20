// @effect-diagnostics nodeBuiltinImport:off - the tests run real servers to see how fetch connects.
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vite-plus/test";

import {
  builtinFetchUsesHttp2,
  configureOutboundFetch,
  extendConnectionAttemptTimeout,
  ignoreMacosTypeOfServiceEinval,
  installHttp1FetchDispatcher,
} from "./outboundHttp.ts";

// Test-only self-signed P-256 certificate for 127.0.0.1, valid until 2126; not a
// secret. Node cannot mint X.509 certificates without a library, and a local
// server only offers h2 over ALPN, which needs TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
const target = NodeHttp.createServer((_request, response) => response.end("direct"));
const proxy = NodeHttp.createServer((_request, response) => response.end("proxied"));
let origin = "";
let targetOrigin = "";
let proxyOrigin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();
const defaultAttemptTimeout = NodeNet.getDefaultAutoSelectFamilyAttemptTimeout();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
  targetOrigin = await listenOnLoopback(target);
  proxyOrigin = await listenOnLoopback(proxy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  Undici.setGlobalDispatcher(defaultDispatcher);
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptTimeout);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const httpServer of [target, proxy]) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

async function listenOnLoopback(httpServer: NodeHttp.Server) {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(httpServer.address() as NodeNet.AddressInfo).port}/`;
}

// Start each case from a shell with no proxy configured.
const clearProxyEnvironment = () => {
  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    vi.stubEnv(name, undefined);
  }
};

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const textViaBuiltinFetch = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

describe("installHttp1FetchDispatcher", () => {
  it("makes the global dispatcher negotiate HTTP/1.1 and keeps the env proxy agent", async () => {
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await versionViaGlobalDispatcher()).toBe("2.0");

    installHttp1FetchDispatcher();
    expect(await versionViaGlobalDispatcher()).toBe("1.1");

    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  // Only a runtime that bundles undici 8 (Node 26+) offers h2 through the
  // built-in fetch, so only there can this prove fetch reads the new dispatcher.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* textViaBuiltinFetch(origin)).toBe("2.0");
        installHttp1FetchDispatcher();
        expect(yield* textViaBuiltinFetch(origin)).toBe("1.1");
      }),
  );
});

describe("configureOutboundFetch", () => {
  it("installs the env proxy agent for HTTPS_PROXY without NODE_USE_ENV_PROXY", () => {
    clearProxyEnvironment();
    vi.stubEnv("HTTPS_PROXY", proxyOrigin);
    configureOutboundFetch();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  it.effect("routes the built-in fetch through HTTP_PROXY", () =>
    Effect.gen(function* () {
      clearProxyEnvironment();
      vi.stubEnv("HTTP_PROXY", proxyOrigin);
      configureOutboundFetch();
      expect(yield* textViaBuiltinFetch(targetOrigin)).toBe("proxied");
    }),
  );

  it.effect("connects directly to hosts listed in NO_PROXY", () =>
    Effect.gen(function* () {
      clearProxyEnvironment();
      vi.stubEnv("HTTP_PROXY", proxyOrigin);
      vi.stubEnv("NO_PROXY", "127.0.0.1");
      configureOutboundFetch();
      expect(yield* textViaBuiltinFetch(targetOrigin)).toBe("direct");
    }),
  );

  it("only replaces the dispatcher for HTTP/2 without proxy variables", () => {
    clearProxyEnvironment();
    configureOutboundFetch();
    const dispatcher = Undici.getGlobalDispatcher();
    if (builtinFetchUsesHttp2(process.versions.undici)) {
      expect(dispatcher).toBeInstanceOf(Undici.Agent);
      expect(dispatcher).not.toBeInstanceOf(Undici.EnvHttpProxyAgent);
    } else {
      expect(dispatcher).toBe(defaultDispatcher);
    }
  });
});

const runNode = Effect.fnUntraced(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(process.execPath, args));
  return yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode.pipe(Effect.map(Number)),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

describe("ignoreMacosTypeOfServiceEinval", () => {
  const errnoError = (code: string) =>
    Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });

  it("swallows only an Error with code EINVAL on macOS", () => {
    let error: unknown = errnoError("EINVAL");
    const prototype = {
      setTypeOfService(this: NodeNet.Socket, _typeOfService: number): NodeNet.Socket {
        throw error;
      },
    };
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    const socket = new NodeNet.Socket();
    expect(prototype.setTypeOfService.call(socket, 0)).toBe(socket);

    error = errnoError("EPERM");
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow(error);

    error = { code: "EINVAL" };
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow();
  });

  it("changes nothing off macOS or on a runtime without setTypeOfService", () => {
    const error = errnoError("EINVAL");
    const prototype = {
      setTypeOfService() {
        throw error;
      },
    };
    const original = prototype.setTypeOfService;
    ignoreMacosTypeOfServiceEinval("linux", prototype);
    ignoreMacosTypeOfServiceEinval("win32", prototype);
    expect(prototype.setTypeOfService).toBe(original);
    expect(() => prototype.setTypeOfService()).toThrow(error);

    const withoutTypeOfService = {};
    ignoreMacosTypeOfServiceEinval("darwin", withoutTypeOfService);
    expect(withoutTypeOfService).not.toHaveProperty("setTypeOfService");
  });

  // Bundled undici 7 calls this API from a socket callback. Keep the real fetch
  // in a child so an escaped EINVAL exits that process instead of breaking Vitest.
  it.effect.runIf(
    typeof (NodeNet.Socket.prototype as { setTypeOfService?: unknown }).setTypeOfService ===
      "function" && process.versions.undici?.startsWith("7.") === true,
  )("keeps built-in fetch working when setTypeOfService throws EINVAL", () =>
    Effect.gen(function* () {
      const child = yield* runNode([
        "--input-type=module",
        "--eval",
        `
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { ignoreMacosTypeOfServiceEinval } from ${JSON.stringify(new URL("./outboundHttp.ts", import.meta.url).href)};

NodeTls.setDefaultCACertificates([${JSON.stringify(TEST_CERT)}]);
let calls = 0;
NodeNet.Socket.prototype.setTypeOfService = () => {
  calls++;
  throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
};
ignoreMacosTypeOfServiceEinval("darwin");
console.log(await (await fetch(${JSON.stringify(origin)})).text());
if (calls === 0) throw new Error("fetch did not call setTypeOfService");
`,
      ]);
      expect(child.exitCode, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("1.1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("guards ordinary CLI and both ACP fast paths before their imports run", () =>
    Effect.gen(function* () {
      const dispatchModules = ["mcp/AcpMcpStdioBridge.ts", "cli/consoleStdin.ts", "binCli.ts"];
      // Load the real entrypoint, but replace dispatch modules to avoid starting
      // the app. Probe at import time, when those modules could first open sockets.
      const preload = `
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

Object.defineProperty(process, "platform", { value: "darwin" });
NodeNet.Socket.prototype.setTypeOfService = () => {
  throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
};
NodeModule.registerHooks({
  load(url, context, nextLoad) {
    const path = ${JSON.stringify(dispatchModules)}.find((path) => url.endsWith("/src/" + path));
    if (path === undefined) return nextLoad(url, context);
    NodeNet.Socket.prototype.setTypeOfService.call(new NodeNet.Socket(), 0);
    console.log(path);
    return {
      format: "module",
      source: "export const runAcpMcpCliFastPath = async () => {}; export const attachConsoleStdin = () => {}; export const runCli = () => {};",
      shortCircuit: true,
    };
  },
});
`;
      const children = yield* Effect.forEach(
        ["--version", "acp-mcp-bridge", "acp-mcp-call"],
        (command) =>
          runNode([
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
            command,
          ]),
      );
      expect(
        children.map((child) => child.exitCode),
        children.map((child) => child.stderr).join("\n"),
      ).toEqual([0, 0, 0]);
      expect(children.map((child) => child.stdout.trim().split("\n"))).toEqual([
        ["cli/consoleStdin.ts", "binCli.ts"],
        ["mcp/AcpMcpStdioBridge.ts"],
        ["mcp/AcpMcpStdioBridge.ts"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("extendConnectionAttemptTimeout", () => {
  it("raises a default below the floor to 1000 ms", () => {
    NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(50);
    extendConnectionAttemptTimeout();
    expect(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1_000);
  });

  it("keeps a larger configured timeout", () => {
    NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
    extendConnectionAttemptTimeout();
    expect(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5_000);
  });
});
