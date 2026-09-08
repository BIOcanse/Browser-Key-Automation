import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import type { LocalRouteConnection } from "../shared/local-route-protocol.js";
import { localRouteConnection, refreshNativeConnection, requestLocalRoute } from "./transport-controller.js";
import { VirtualMouseError } from "./virtual-mouse-model.js";

export interface AcquiredNativeRoute { readonly routeId: string; readonly connection: LocalRouteConnection }
export type AcquireNativeRoute = (stepDeadlineMs: number) => Promise<AcquiredNativeRoute>;

// One admitted command owns one attempt; action children share this object.
// The App owns the actual table entry, including orphaned/unconfirmed opens.
export class LocalCommandRoute {
  private closed = false;
  private attempt: Promise<AcquiredNativeRoute> | undefined;
  private acquired: AcquiredNativeRoute | undefined;

  constructor(readonly deadlineMs: number) {}

  private remaining(stepDeadlineMs = Infinity): number {
    if (this.closed) throw new VirtualMouseError("local_route_finished");
    const remaining = Math.floor(Math.min(this.deadlineMs, stepDeadlineMs) - performance.now());
    if (remaining < 1) throw new VirtualMouseError("timeout");
    return remaining;
  }

  readonly acquire: AcquireNativeRoute = async stepDeadlineMs => {
    this.remaining(stepDeadlineMs);
    await refreshNativeConnection();
    this.remaining(stepDeadlineMs);
    this.attempt ??= this.open();
    const acquired = await this.attempt;
    this.remaining(stepDeadlineMs);
    const current = localRouteConnection();
    if (current.connectionGeneration !== acquired.connection.connectionGeneration || current.relayEpoch !== acquired.connection.relayEpoch) throw new VirtualMouseError("connection_changed");
    return acquired;
  };

  private async open(): Promise<AcquiredNativeRoute> {
    const connection = localRouteConnection();
    const receipt = await requestLocalRoute({ kind: "route.local.open", requestId: crypto.randomUUID(),
      durationMs: Math.min(this.remaining(), TRANSPORT_CONFIG.localRoute.maximumDurationMs) }, connection);
    if (!receipt.confirmed || !receipt.response.ok) throw new VirtualMouseError(receipt.response.ok ? "local_route_unconfirmed" : receipt.response.error.reason);
    if (!("routeId" in receipt.response.result)) throw new VirtualMouseError("local_route_response_invalid");
    this.acquired = { routeId: receipt.response.result.routeId, connection };
    return this.acquired;
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.acquired === undefined) return;
    try {
      const receipt = await requestLocalRoute({ kind: "route.local.close", requestId: crypto.randomUUID(), routeId: this.acquired.routeId }, this.acquired.connection);
      if (!receipt.confirmed || !receipt.response.ok) console.warn("BKA local route close remains unconfirmed; App expiry retained");
    } catch { console.warn("BKA local route close could not be observed; App expiry retained"); }
  }
}
