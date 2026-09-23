import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export type WizardEnvironmentStatus =
  | { readonly kind: "connected"; readonly text: "Connected" }
  | { readonly kind: "connecting"; readonly text: "Connecting…" }
  | { readonly kind: "off"; readonly text: "Off" }
  | { readonly kind: "failed"; readonly text: string };

/**
 * Status shown next to a computer in the welcome wizard. A switched-off
 * environment never opens a socket, so it must not read as connecting; the
 * wizard offers to turn it on instead.
 */
export function resolveWizardEnvironmentStatus(input: {
  readonly enabled: boolean;
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
}): WizardEnvironmentStatus {
  if (!input.enabled) return { kind: "off", text: "Off" };
  switch (input.phase) {
    case "connected":
      return { kind: "connected", text: "Connected" };
    case "offline":
      return { kind: "failed", text: "Offline" };
    case "error":
      return {
        kind: "failed",
        text: input.error ? `Connection failed: ${input.error}` : "Connection failed",
      };
    case "unsupported":
      return {
        kind: "failed",
        text: input.error ? `Not supported: ${input.error}` : "Not supported",
      };
    default:
      return { kind: "connecting", text: "Connecting…" };
  }
}
