// ============================================================================
//  APPLICATION · Chính sách cho hai nhóm TĨNH: IDENTITY và PARTICULARS
// ----------------------------------------------------------------------------
//  Mọi hằng số nằm ở đây, không rải trong resolver — cùng nguyên tắc với
//  `PositionResolverPolicy` (P8.2) và `SourceRuntimeConfig` (P4).
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";

const DAY = 24 * 60 * 60 * 1000;

export interface IdentityResolverPolicy {
  /**
   * Nguồn ưu tiên cho `vesselType`.
   *
   * Bằng chứng: cùng tàu AGIA DOXA, ShipInfo cho `"Bulk Carrier"` còn ShipFinder
   * cho `"Cargo ship"`. Cả hai ĐỀU ĐÚNG — `Bulk Carrier` là loại con của
   * `Cargo ship` — nhưng chọn nhãn tổng quát là **mất thông tin**. ShipInfo cho
   * nhãn cụ thể hơn ở 2/2 tàu đối chiếu.
   *
   * Đây là MỘT DÒNG CẤU HÌNH, không phải taxonomy loại tàu. Khi dự án có
   * taxonomy thật thì thay luật này, không phải viết lại resolver.
   */
  vesselTypePreference: readonly VesselSource[];
  /** Cửa sổ nạp ứng viên. Identity gần như bất biến -> cửa sổ rộng. */
  candidateWindowMs: number;
}

export const DEFAULT_IDENTITY_RESOLVER_POLICY: Readonly<IdentityResolverPolicy> = Object.freeze({
  vesselTypePreference: Object.freeze([
    VesselSource.SHIPINFO,
    VesselSource.VESSELFINDER,
    VesselSource.SHIPFINDER,
  ]),
  candidateWindowMs: 90 * DAY,
});

export interface NumericTolerance {
  absolute?: number;
  relative?: number;
}

export interface ParticularsResolverPolicy {
  /**
   * Dung sai coi hai số là BẰNG NHAU. Chỉ để phân loại "không phải xung đột",
   * TUYỆT ĐỐI không dùng để lấy trung bình.
   */
  lengthTolerance: NumericTolerance;
  beamTolerance: NumericTolerance;
  draughtTolerance: NumericTolerance;
  tonnageTolerance: NumericTolerance;
  /** Năm đóng lệch 1 là SAI THẬT, không phải làm tròn -> dung sai bằng 0. */
  builtYearTolerance: NumericTolerance;
  candidateWindowMs: number;
}

export const DEFAULT_PARTICULARS_RESOLVER_POLICY: Readonly<ParticularsResolverPolicy> =
  Object.freeze({
    // 1 m: chênh lệch làm tròn, hoặc LOA vs LBP.
    lengthTolerance: Object.freeze({ absolute: 1 }),
    beamTolerance: Object.freeze({ absolute: 1 }),
    // Mớn nước đo tới 0.1 m; 0.2 m là sai số hợp lý giữa hai lần đọc.
    draughtTolerance: Object.freeze({ absolute: 0.2 }),
    // Tấn: sai số tương đối 2 %.
    tonnageTolerance: Object.freeze({ relative: 0.02 }),
    builtYearTolerance: Object.freeze({}),
    candidateWindowMs: 90 * DAY,
  });
