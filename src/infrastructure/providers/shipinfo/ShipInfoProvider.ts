// ============================================================================
//  INFRASTRUCTURE · ShipInfoProvider — implements VesselDataProvider (P3)
// ----------------------------------------------------------------------------
//      VesselIdentifier -> ShipInfoClient -> HTML -> ShipInfoParser
//                       -> ShipInfoMapper -> ProviderResult
//
//  DỪNG ở ProviderResult. Không ObservationRecorder, không DB, không resolver.
//
//  KHÔNG có retry/backoff/rate limit/cooldown/health ở đây — đã có ở P4
//  (SourceRequestExecutor). Nối vào là việc của P6.4. Viết lại lần nữa sẽ nhân
//  đôi số request mà không ai nhìn thấy (CRAWL_RUNTIME.md §9).
//
//  ⛔ KHÔNG `searchByName`: endpoint duy nhất nằm dưới `/api/` mà robots.txt của
//  ShipInfo cấm. ⛔ KHÔNG `scanArea`: nguồn không có truy vấn theo bbox.
//  Method vắng mặt CHÍNH LÀ câu trả lời — registry đọc được qua
//  `providerSupportsOperation`.
// ============================================================================

import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../../../application/providers/ProviderResults";
import { VesselDataProvider } from "../../../application/providers/VesselDataProvider";
import { VesselIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { ShipInfoClient } from "./ShipInfoClient";
import {
  buildShipInfoMetadata,
  resolveLatestSourceInstant,
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
} from "./ShipInfoMapper";
import { ShipInfoParsedDocument } from "./ShipInfoTypes";
import { parseShipInfoHtml } from "./ShipInfoParser";

export interface ShipInfoProviderDeps {
  client: ShipInfoClient;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

export class ShipInfoProvider implements VesselDataProvider {
  readonly source = VesselSource.SHIPINFO;

  private readonly client: ShipInfoClient;
  private readonly now: () => Date;

  constructor(deps: ShipInfoProviderDeps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Lý lịch + vị trí mới nhất nếu suy được mốc thời gian.
   *
   * @returns null khi nguồn KHÔNG CÓ tàu này (kể cả khi ShipInfo trả HTTP 200
   *          kèm PHP fatal error — status code của nguồn này vô dụng).
   * @throws ShipInfoParseError khi khối JSON nhúng hỏng. Nguồn đổi định dạng
   *         KHÁC HẲN tàu không tồn tại; nuốt nó thành `null` là mất tín hiệu
   *         drift và âm thầm xoá dữ liệu đang có.
   */
  async getDetails(identifier: VesselIdentifier): Promise<ProviderDetailsResult | null> {
    const document = await this.load(identifier);
    if (document === null) return null;

    const fetchedAt = this.now();
    // Lý lịch không mang mốc thời gian của nguồn -> sourceReceivedAt = null.
    const staticMetadata = buildShipInfoMetadata(fetchedAt, null);

    const result: ProviderDetailsResult = {};

    const identity = toVesselIdentity(document, staticMetadata);
    if (identity !== null) result.identity = identity;

    const particulars = toVesselParticulars(document, staticMetadata, fetchedAt);
    if (particulars !== null) result.particulars = particulars;

    const position = this.buildPosition(document, fetchedAt);
    if (position !== null) result.position = position;

    // KHÔNG có nhóm voyage: destination/eta null ở 0/1073 điểm. Trả một khối
    // toàn null là tự nhận có phủ sóng mà thực tế không có.
    return result;
  }

  /**
   * Vị trí dùng được mới nhất.
   *
   * @returns null khi không có tàu, `points` rỗng, mọi điểm hỏng toạ độ, hoặc
   *          không suy được mốc thời gian thật của nguồn. KHÔNG bao giờ trả
   *          toạ độ bịa (0,0) và không mượn giờ fetch làm giờ vị trí.
   */
  async getPosition(identifier: VesselIdentifier): Promise<ProviderPositionResult | null> {
    const document = await this.load(identifier);
    if (document === null) return null;

    const fetchedAt = this.now();
    const position = this.buildPosition(document, fetchedAt);
    if (position === null) return null;

    const result: ProviderPositionResult = { position };
    const identity = toVesselIdentity(document, buildShipInfoMetadata(fetchedAt, null));
    if (identity !== null) result.identity = identity;
    return result;
  }

  // ---- private ------------------------------------------------------------

  /** Tải + parse. `null` = nguồn không có tàu. Lỗi parse thì ném tiếp. */
  private async load(identifier: VesselIdentifier): Promise<ShipInfoParsedDocument | null> {
    const html = await this.fetch(identifier);
    const parsed = parseShipInfoHtml(html);
    return parsed.status === "OK" ? parsed.document : null;
  }

  private fetch(identifier: VesselIdentifier): Promise<string> {
    switch (identifier.type) {
      case "MMSI":
        return this.client.fetchByMmsi(identifier.value);
      case "IMO":
        return this.client.fetchByImo(identifier.value);
      default: {
        // Union chỉ có hai nhánh; đây là lưới an toàn cho dữ liệu ép kiểu từ
        // bên ngoài. Ném TRƯỚC khi chạm mạng.
        const unsupported = identifier as { type?: unknown };
        return Promise.reject(
          new Error(`ShipInfoProvider: không hỗ trợ định danh "${String(unsupported.type)}"`)
        );
      }
    }
  }

  /**
   * Metadata của nhóm Position mang `sourceReceivedAt` THẬT (nếu suy được), nên
   * dựng riêng chứ không dùng chung với metadata lý lịch.
   */
  private buildPosition(document: ShipInfoParsedDocument, fetchedAt: Date) {
    const sourceInstant = resolveLatestSourceInstant(document);
    return toVesselPositionReport(document, buildShipInfoMetadata(fetchedAt, sourceInstant));
  }
}
