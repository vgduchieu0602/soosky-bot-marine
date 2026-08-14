// ============================================================================
//  INFRASTRUCTURE · ShipFinderProvider — implements VesselDataProvider (P3)
// ----------------------------------------------------------------------------
//      VesselIdentifier(MMSI) -> ShipFinderClient -> HTML -> ShipFinderParser
//                             -> ShipFinderMapper -> ProviderResult
//
//  DỪNG ở ProviderResult. Không ObservationRecorder, không DB, không resolver.
//
//  KHÔNG retry/backoff/rate limit/cooldown/health ở đây — đã có ở P4
//  (SourceRequestExecutor). Nối vào là việc của P7.4.
//
//  ⛔ CHỈ MMSI. Audit P7.1: `/ship/detail/imo/{imo}` -> 404, và nhét IMO vào khe
//  mmsi thì trang trả HTTP 200 với mọi ô là "-". Nhận định danh IMO -> ném NGAY,
//  KHÔNG chạm mạng, KHÔNG thử ghép IMO vào URL mmsi, KHÔNG dò sitemap, KHÔNG
//  quay sang nguồn khác (provider architecture không làm fallback).
//
//  ⛔ KHÔNG `searchByName` (endpoint duy nhất bị ký chữ ký), KHÔNG `scanArea`
//  (nguồn không có truy vấn theo bbox). Method vắng mặt CHÍNH LÀ câu trả lời.
// ============================================================================

import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../../../application/providers/ProviderResults";
import { VesselDataProvider } from "../../../application/providers/VesselDataProvider";
import { VesselIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { ShipFinderClient } from "./ShipFinderClient";
import {
  ShipFinderMappingOptions,
  buildShipFinderMetadata,
  resolveSourceInstant,
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
  toVesselVoyage,
} from "./ShipFinderMapper";
import { parseError } from "../../../application/runtime/SourceError";
import { ShipFinderParseError, parseShipFinderHtml } from "./ShipFinderParser";
import { ShipFinderRawVessel } from "./ShipFinderTypes";

export interface ShipFinderProviderDeps {
  client: ShipFinderClient;
  /**
   * Độ lệch múi giờ của `Last update`, tính bằng phút so với UTC.
   *
   * ⚠️ Không truyền -> provider **không phát ra vị trí** (identity/particulars/
   * voyage vẫn có). Đây là mặc định BẢO THỦ có chủ ý: ShipFinder không khai báo
   * múi giờ ở đâu cả, và P7.1 chỉ *suy luận* ra UTC+8 (=480). Truyền giá trị
   * này nghĩa là người vận hành ký tên vào giả định đó.
   * Xem ShipFinderMapper.ShipFinderMappingOptions.
   */
  sourceUtcOffsetMinutes?: number;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

export class ShipFinderProvider implements VesselDataProvider {
  readonly source = VesselSource.SHIPFINDER;

  private readonly client: ShipFinderClient;
  private readonly sourceUtcOffsetMinutes?: number;
  private readonly now: () => Date;

  constructor(deps: ShipFinderProviderDeps) {
    this.client = deps.client;
    this.sourceUtcOffsetMinutes = deps.sourceUtcOffsetMinutes;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Lý lịch + chuyến đi + vị trí (nếu mốc thời gian xác định được).
   *
   * @returns null khi nguồn KHÔNG CÓ tàu này — kể cả khi ShipFinder trả HTTP
   *          200 kèm trang đầy đủ nhưng mọi ô là "-".
   * @throws ShipFinderParseError khi trang là trang tàu nhưng mất neo dữ liệu.
   *         Nguồn đổi cấu trúc KHÁC HẲN tàu không tồn tại; nuốt nó thành `null`
   *         là mất tín hiệu drift.
   * @throws Error khi định danh không phải MMSI — ném TRƯỚC khi chạm mạng.
   */
  async getDetails(identifier: VesselIdentifier): Promise<ProviderDetailsResult | null> {
    const raw = await this.load(identifier);
    if (raw === null) return null;

    const fetchedAt = this.now();
    const options = this.mappingOptions(fetchedAt);
    // Lý lịch/chuyến đi không mang mốc thời gian của nguồn -> sourceReceivedAt null.
    const staticMetadata = buildShipFinderMetadata(fetchedAt, null);

    const result: ProviderDetailsResult = {};

    const identity = toVesselIdentity(raw, staticMetadata);
    if (identity !== null) result.identity = identity;

    const particulars = toVesselParticulars(raw, staticMetadata);
    if (particulars !== null) result.particulars = particulars;

    const voyage = toVesselVoyage(raw, staticMetadata);
    if (voyage !== null) result.voyage = voyage;

    const position = this.buildPosition(raw, fetchedAt, options);
    if (position !== null) result.position = position;

    return result;
  }

  /**
   * Vị trí hiện tại.
   *
   * @returns null khi không có tàu, toạ độ DDM hỏng, hoặc không xác định được
   *          mốc thời gian nguồn. KHÔNG bao giờ trả toạ độ bịa (0,0) và KHÔNG
   *          mượn giờ fetch làm giờ vị trí.
   */
  async getPosition(identifier: VesselIdentifier): Promise<ProviderPositionResult | null> {
    const raw = await this.load(identifier);
    if (raw === null) return null;

    const fetchedAt = this.now();
    const position = this.buildPosition(raw, fetchedAt, this.mappingOptions(fetchedAt));
    if (position === null) return null;

    const result: ProviderPositionResult = { position };
    const identity = toVesselIdentity(raw, buildShipFinderMetadata(fetchedAt, null));
    if (identity !== null) result.identity = identity;
    return result;
  }

  // ---- private ------------------------------------------------------------

  /**
   * Tải + parse. `null` = nguồn không có tàu.
   *
   * Trang mất neo -> đổi sang `SourceRequestError(PARSE_ERROR)` của P4. Đây là
   * BIÊN dịch lỗi: `ShipFinderParseError` là khái niệm riêng của nguồn này,
   * runtime chỉ hiểu `SourceErrorCategory`. Không dịch thì nó rơi vào UNKNOWN và
   * `parseErrorCount` không bao giờ tăng — mất luôn tín hiệu nguồn đổi cấu trúc.
   * Lỗi gốc giữ trong `cause`.
   */
  private async load(identifier: VesselIdentifier): Promise<ShipFinderRawVessel | null> {
    const html = await this.fetch(identifier);
    try {
      const parsed = parseShipFinderHtml(html);
      return parsed.status === "OK" ? parsed.document.vessel : null;
    } catch (err) {
      if (err instanceof ShipFinderParseError) {
        throw parseError(this.source, err.message, err);
      }
      throw err;
    }
  }

  private fetch(identifier: VesselIdentifier): Promise<string> {
    if (identifier.type !== "MMSI") {
      // Ném TRƯỚC khi chạm mạng. Không thử ghép IMO vào URL mmsi (P7.1 đã
      // chứng minh cách đó chỉ ra trang rỗng), không fallback sang nguồn khác.
      return Promise.reject(
        new Error(
          `ShipFinderProvider: chỉ hỗ trợ định danh MMSI, nhận "${identifier.type}". ` +
            "ShipFinder không có đường tra theo IMO."
        )
      );
    }
    return this.client.fetchByMmsi(identifier.value);
  }

  private mappingOptions(fetchedAt: Date): ShipFinderMappingOptions {
    return { sourceUtcOffsetMinutes: this.sourceUtcOffsetMinutes, now: fetchedAt };
  }

  /**
   * Metadata của nhóm Position mang `sourceReceivedAt` THẬT (khi xác định được)
   * nên dựng riêng, không dùng chung với metadata lý lịch.
   */
  private buildPosition(
    raw: ShipFinderRawVessel,
    fetchedAt: Date,
    options: ShipFinderMappingOptions
  ) {
    const sourceInstant = resolveSourceInstant(raw, options);
    return toVesselPositionReport(
      raw,
      buildShipFinderMetadata(fetchedAt, sourceInstant),
      options
    );
  }
}
