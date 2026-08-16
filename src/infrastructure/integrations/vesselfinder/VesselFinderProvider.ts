// ============================================================================
//  INFRASTRUCTURE · VesselFinderProvider — BỌC legacy source vào interface mới
// ----------------------------------------------------------------------------
//  KHÔNG viết lại VesselFinderHtmlSource / VesselFinderMapSource. Provider này
//  dùng COMPOSITION: nhận đúng 2 source đang chạy production, gọi lại chúng, rồi
//  dịch entity cũ -> canonical bằng mapping A1 (legacyMapping.ts).
//
//  Nhận vào PORT (`IVesselDetailsSource`, `IAreaScanner`) chứ không phải class
//  cụ thể: container vẫn tiêm đúng 2 instance thật, còn test tiêm giả lập được
//  mà không đụng mạng.
//
//  ⚠️ TRUNG THỰC DỮ LIỆU là ràng buộc chính ở đây:
//    • mp2 chỉ có mmsi/name/lat/lon -> KHÔNG bịa speed/course/heading/navStatus.
//      Các field đó để VẮNG MẶT, không phải null cho đủ bộ.
//    • mp2 không kèm mốc thời gian của nguồn -> `sourceReceivedAt = null`.
//      TUYỆT ĐỐI không lấy `fetchedAt` (đồng hồ của bot) gán sang.
//    • Trang chi tiết có `lrpd` ("0 min ago") nhưng là chuỗi TƯƠNG ĐỐI, parse ra
//      sẽ sai -> cũng không dùng làm `sourceReceivedAt`.
//    • Voyage: mapper hiện KHÔNG bóc destination/eta, nên provider KHÔNG trả
//      nhóm voyage — trả một khối toàn null là tự nhận có phủ sóng mà thực tế
//      không (khớp SOURCE_CAPABILITY_MATRIX: vesselfinder.voyage = false).
//
//  Provider này TỒN TẠI SONG SONG với đường legacy. Không use case nào gọi nó ở
//  P3 — xem PROVIDER_ARCHITECTURE.md §6/§8.
// ============================================================================

import { BoundingBox } from "../../../application/contracts/geo/Geo";
import { IAreaScanner, ScannedShip } from "../../../application/contracts/geo/IAreaScanner";
import { IVesselDetailsSource } from "../../../application/contracts/providers/IVesselDetailsSource";
import {
  ProviderDetailsResult,
  ProviderPositionResult,
} from "../../../application/contracts/providers/ProviderResults";
import { VesselDataProvider } from "../../../application/contracts/providers/VesselDataProvider";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import {
  toVesselIdentity,
  toVesselParticulars,
  toVesselPositionReport,
} from "../../../legacy/mappers/legacyMapping";
import { SourceMetadata, createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";

/**
 * Mã lỗi "không tìm thấy tàu" của domain (AppError E-1001).
 * So sánh bằng chuỗi là nợ kỹ thuật D-6 đã ghi nhận ở CURRENT_ARCHITECTURE.md §6 —
 * gom về một chỗ là việc của phase xử lý error policy, không phải P3.
 */
const SHIP_NOT_FOUND_CODE = "E-1001";

export interface VesselFinderProviderDeps {
  /** VesselFinderHtmlSource đang chạy production. */
  detailsSource: IVesselDetailsSource;
  /** VesselFinderMapSource (mp2) đang chạy production. */
  areaScanner: IAreaScanner;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

export class VesselFinderProvider implements VesselDataProvider {
  readonly source = VesselSource.VESSELFINDER;

  private readonly detailsSource: IVesselDetailsSource;
  private readonly areaScanner: IAreaScanner;
  private readonly now: () => Date;

  constructor(deps: VesselFinderProviderDeps) {
    this.detailsSource = deps.detailsSource;
    this.areaScanner = deps.areaScanner;
    this.now = deps.now ?? (() => new Date());
  }

  // -- searchByName CỐ Ý KHÔNG implement --------------------------------------
  //  Repo không có đường tra theo tên của VesselFinder. Method vắng mặt là câu
  //  trả lời "không hỗ trợ" mà registry đọc được — hơn hẳn việc khai method rồi
  //  ném "not implemented".

  /**
   * Chi tiết một tàu qua trang HTML.
   * @returns null khi nguồn không có tàu này (E-1001). Lỗi khác (bị chặn,
   *          timeout, parse hỏng) ĐƯỢC NÉM TIẾP — "hỏng" khác "không có".
   */
  async getDetails(identifier: VesselIdentifier): Promise<ProviderDetailsResult | null> {
    const legacy = await this.fetchDetails(identifier);
    if (legacy === null) return null;

    const { details, metadata } = legacy;
    const result: ProviderDetailsResult = {
      identity: toVesselIdentity(details.vessel, metadata),
      particulars: toVesselParticulars(details.vessel, metadata),
    };

    // Trang chi tiết có thể thiếu toạ độ -> mapping trả null -> bỏ hẳn nhóm.
    const position = toVesselPositionReport(details.position, metadata);
    if (position !== null) result.position = position;

    // KHÔNG có nhóm voyage: xem ghi chú đầu file.
    return result;
  }

  /**
   * Vị trí một tàu, lấy từ chính trang chi tiết.
   * ⚠️ Toạ độ ở đây bị VesselFinder LÀM TRÒN (~111km) -> `latLngApproximate`
   * do mapping A1 giữ nguyên = true. Muốn toạ độ chính xác phải dùng scanArea.
   */
  async getPosition(identifier: VesselIdentifier): Promise<ProviderPositionResult | null> {
    const legacy = await this.fetchDetails(identifier);
    if (legacy === null) return null;

    const { details, metadata } = legacy;
    const position = toVesselPositionReport(details.position, metadata);
    if (position === null) return null;

    return { position, identity: toVesselIdentity(details.vessel, metadata) };
  }

  /**
   * Quét một vùng qua mp2. Toạ độ CHÍNH XÁC (không làm tròn).
   * Tàu decode ra thiếu khoá/toạ độ hợp lệ bị loại, không đẩy rác lên trên.
   */
  async scanArea(box: BoundingBox): Promise<readonly ProviderPositionResult[]> {
    const ships = await this.areaScanner.fetchArea(box);
    const fetchedAt = this.now();
    const metadata = this.buildMetadata(fetchedAt);

    const results: ProviderPositionResult[] = [];
    for (const ship of ships) {
      const result = VesselFinderProvider.toPositionResult(ship, metadata, fetchedAt);
      if (result !== null) results.push(result);
    }
    return Object.freeze(results);
  }

  // ---- private --------------------------------------------------------------

  /** Gọi source cũ + gắn metadata. `null` = nguồn báo không có tàu. */
  private async fetchDetails(identifier: VesselIdentifier): Promise<{
    details: Awaited<ReturnType<IVesselDetailsSource["getDetails"]>>;
    metadata: SourceMetadata;
  } | null> {
    try {
      // Source cũ nhận string và tự xử lý cả IMO lẫn MMSI (VesselFinder redirect
      // 301) -> giữ nguyên hành vi tương thích, chỉ truyền phần value.
      const details = await this.detailsSource.getDetails(identifier.value);
      return { details, metadata: this.buildMetadata(this.now()) };
    } catch (err) {
      if ((err as { code?: string } | null)?.code === SHIP_NOT_FOUND_CODE) return null;
      throw err;
    }
  }

  /**
   * `sourceReceivedAt` LUÔN null cho VesselFinder: mp2 không kèm timestamp, và
   * `lrpd` của trang chi tiết là chuỗi tương đối không đáng tin.
   */
  private buildMetadata(fetchedAt: Date): SourceMetadata {
    return createSourceMetadata({
      source: VesselSource.VESSELFINDER,
      fetchedAt,
      sourceReceivedAt: null,
    });
  }

  /**
   * ScannedShip (mp2) -> canonical. Chỉ 4 field mp2 thật sự có; speed/course/
   * heading/navStatus KHÔNG được đặt vào object.
   */
  private static toPositionResult(
    ship: ScannedShip,
    metadata: SourceMetadata,
    receivedAt: Date
  ): ProviderPositionResult | null {
    const mmsi = String(ship.mmsi ?? "").trim();
    if (mmsi === "") return null;
    if (!Number.isFinite(ship.lat) || !Number.isFinite(ship.lon)) return null;

    const position: VesselPositionReport = {
      mmsi,
      lat: ship.lat,
      lng: ship.lon,
      // mp2 cho toạ độ chính xác, khác trang chi tiết.
      latLngApproximate: false,
      receivedAt,
      metadata,
    };

    const identity: VesselIdentity = {
      mmsi,
      name: VesselFinderProvider.realName(ship.name, mmsi),
      metadata,
    };

    return { position, identity };
  }

  /**
   * Decoder mp2 đặt `name = String(mmsi)` khi bản ghi không có tên. Đó là chỗ
   * giữ chỗ, không phải tên tàu -> canonical trả null thay vì nhân bản mmsi
   * thành một cái tên giả.
   */
  private static realName(name: string | null | undefined, mmsi: string): string | null {
    const trimmed = (name ?? "").trim();
    if (trimmed === "" || trimmed === mmsi) return null;
    return trimmed;
  }
}
