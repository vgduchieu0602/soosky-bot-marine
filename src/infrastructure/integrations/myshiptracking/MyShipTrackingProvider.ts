// ============================================================================
//  INFRASTRUCTURE · MyShipTrackingProvider — paid current-position adapter
// ----------------------------------------------------------------------------
//  VesselIdentifier -> MyShipTrackingClient -> MyShipTrackingMapper -> ProviderResult
//
//  Registering this provider never makes it free: FreeSourceSelector excludes
//  MYSHIPTRACKING because its capability cost type is PAID.
// ============================================================================

import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../../../application/contracts/providers/ProviderResults";
import { VesselDataProvider } from "../../../application/contracts/providers/VesselDataProvider";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { VesselIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import {
  MyShipTrackingClient,
  MyShipTrackingFailure,
  MyShipTrackingFetchResult,
  MyShipTrackingQuery,
} from "./MyShipTrackingClient";
import { toProviderResult } from "./MyShipTrackingMapper";
import { MyShipTrackingSimpleData } from "./MyShipTrackingTypes";

export class MyShipTrackingProviderError extends Error {
  readonly failure: MyShipTrackingFailure;

  constructor(failure: MyShipTrackingFailure) {
    super(`MyShipTracking current-position request failed: ${failure}`);
    this.name = "MyShipTrackingProviderError";
    this.failure = failure;
  }
}

export interface MyShipTrackingProviderDeps {
  client: MyShipTrackingClient;
  now?: () => Date;
}

export class MyShipTrackingProvider implements VesselDataProvider {
  readonly source = VesselSource.MYSHIPTRACKING;

  private readonly client: MyShipTrackingClient;
  private readonly now: () => Date;

  constructor(deps: MyShipTrackingProviderDeps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  /** Surface retained for the explicit paid use case, including credit metadata. */
  fetchCurrentPosition(query: MyShipTrackingQuery): Promise<MyShipTrackingFetchResult> {
    return this.client.fetchCurrentPosition(query);
  }

  /** Maps a successful simple response to the existing canonical provider DTO. */
  toProviderResult(data: unknown, fetchedAt: Date): ProviderDetailsResult {
    return toProviderResult(data as MyShipTrackingSimpleData, fetchedAt);
  }

  /**
   * Standard provider-port form for callers that need only canonical position.
   * `null` is reserved for documented 404/no-useful-position; other paid
   * failures remain explicit instead of being silently mistaken for a miss.
   */
  async getPosition(identifier: VesselIdentifier): Promise<ProviderPositionResult | null> {
    const fetched = await this.fetchCurrentPosition(MyShipTrackingProvider.toQuery(identifier));
    if (!fetched.ok) {
      if (fetched.failure === MyShipTrackingFailure.NOT_FOUND) return null;
      throw new MyShipTrackingProviderError(fetched.failure);
    }

    const result = this.toProviderResult(fetched.data, this.now());
    if (result.position === undefined) return null;
    return result.identity === undefined
      ? { position: result.position }
      : { position: result.position, identity: result.identity };
  }

  private static toQuery(identifier: VesselIdentifier): MyShipTrackingQuery {
    return identifier.type === "MMSI" ? { mmsi: identifier.value } : { imo: identifier.value };
  }
}
