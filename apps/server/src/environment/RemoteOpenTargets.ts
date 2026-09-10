/**
 * RemoteOpenTargets - resolves the SSH hostnames this environment advertises
 * for remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`).
 *
 * The server can only check itself: sshd listening locally, tailscaled
 * reporting a MagicDNS name and whether Tailscale SSH serves it, and the
 * machine hostname for mDNS. Whether a
 * given name resolves from the viewer's machine is inherently client-side.
 * Targets are ordered most-reachable first (tailnet name works from anywhere
 * on the tailnet; `<hostname>.local` only on the same LAN).
 */
import { type RemoteOpenTarget } from "@t3tools/contracts";
import { HostProcessHostname } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const SSH_PORT = 22;

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  const resolveTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );

    // Tailscale absent or down is the common case, not an error.
    const tailscale = yield* readTailscaleStatus.pipe(
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    // Tailscale SSH answers on the tailnet name without any local sshd, so
    // the tailnet target only needs one of the two to be serving.
    if (tailscale?.magicDnsName && (sshdListening || tailscale.sshEnabled)) {
      targets.push({ kind: "tailscale", host: tailscale.magicDnsName });
    }

    // Without a local sshd no LAN name can work; advertise nothing there so
    // clients render a clear "no SSH route" state instead of links that hang.
    // os.hostname() may already be an FQDN (macOS often reports
    // "Name.local"); mDNS names are always `<first-label>.local`.
    if (sshdListening) {
      const hostname = yield* HostProcessHostname;
      const shortHostname = hostname.split(".")[0]?.trim();
      if (shortHostname !== undefined && shortHostname.length > 0) {
        targets.push({ kind: "mdns", host: `${shortHostname}.local` });
      }
    }

    return targets;
  });

  return RemoteOpenTargets.of({ resolveTargets: () => resolveTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
