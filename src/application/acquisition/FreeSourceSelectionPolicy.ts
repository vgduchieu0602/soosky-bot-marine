// ============================================================================
//  APPLICATION · Chính sách chọn nguồn free
// ----------------------------------------------------------------------------
//  Mọi con số và mọi thứ tự nằm ở ĐÂY, không rải trong selector.
//
//  ⚠️ Đây KHÔNG phải bảng thay thế `SOURCE_CAPABILITY_MATRIX`. Matrix là nguồn
//  sự thật đầu tiên: nguồn nào CONFIRMED field nào. Policy chỉ khai những thứ
//  matrix KHÔNG diễn đạt được — cụ thể là "hai nguồn cùng CONFIRMED vị trí,
//  nhưng một nguồn trễ 14 giờ".
// ============================================================================

import { VesselFieldGroup } from "../../domain/value-objects/VesselField";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { DEFAULT_POSITION_RESOLVER_POLICY } from "../resolver/PositionResolverPolicy";

const MINUTE = 60 * 1000;

export interface FreeSourceSelectionPolicy {
  /**
   * Thứ tự ưu tiên RIÊNG cho vị trí — thứ `defaultPriority` không diễn đạt được.
   *
   * Bằng chứng: ShipInfo có `defaultPriority` 45 (tốt hơn ShipFinder 55) nhưng
   * vị trí bản free bị khoá trễ **~14 giờ** có chủ ý, còn POC P7 đo ShipFinder
   * trả vị trí tuổi **1–37 phút**. Sắp theo priority là gọi trước đúng nguồn
   * không giải được bài toán. Con số 55 được giữ nguyên có chủ ý ở P7.4
   * (SOURCE_CAPABILITY_MATRIX.md §5) — nên chỗ sửa đúng là ở đây.
   *
   * ⚠️ Đây chỉ là thứ tự. Nguồn trong danh sách vẫn phải qua mọi cổng lọc:
   * không CONFIRMED field cần, hoặc không tra được bằng định danh đang có, thì
   * có mặt ở đây cũng không được chọn.
   */
  readonly positionPreference: readonly VesselSource[];

  /**
   * Khi coverage bằng nhau, nhóm nào được giải trước.
   *
   * Dữ liệu ĐỘNG đứng trước dữ liệu tĩnh: vị trí và chuyến đi cũ đi theo thời
   * gian, còn `length`/`builtYear` thì không — hoãn chúng một lượt không mất gì.
   */
  readonly dynamicGroupOrder: readonly VesselFieldGroup[];

  /**
   * Cửa sổ chặn sau khi một nguồn trả `NOT_FOUND` cho CHÍNH con tàu này.
   *
   * 15 phút = `cooldownMs` mà cả ShipInfo lẫn ShipFinder đang khai trong
   * `SOURCE_RUNTIME_OVERRIDES`. Không bịa số mới: nếu 15 phút là quãng nghỉ đủ
   * lịch sự khi nguồn hỏng, nó cũng đủ cho "nguồn vừa nói không có tàu này".
   */
  readonly recentNotFoundTtlMs: number;

  /**
   * Cửa sổ chặn sau khi một nguồn trả dữ liệu THÀNH CÔNG mà vẫn chưa đủ.
   *
   * 30 phút = `liveMaxAgeMs`. Trước mốc đó, thứ vừa lấy về VẪN còn ở bậc `LIVE`
   * — gọi lại không thể đổi bậc, chỉ tốn một request. Đây là hàng rào chống
   * vòng lặp mạnh nhất: nguồn chỉ có bấy nhiêu thì hỏi lại vẫn bấy nhiêu.
   */
  readonly recentSuccessTtlMs: number;
}

export const DEFAULT_FREE_SOURCE_SELECTION_POLICY: Readonly<FreeSourceSelectionPolicy> =
  Object.freeze({
    positionPreference: Object.freeze([
      VesselSource.SHIPFINDER,
      VesselSource.VESSELFINDER,
      VesselSource.SHIPINFO,
    ]),
    dynamicGroupOrder: Object.freeze([
      VesselFieldGroup.POSITION,
      VesselFieldGroup.VOYAGE,
      VesselFieldGroup.IDENTITY,
      VesselFieldGroup.PARTICULARS,
    ]),
    recentNotFoundTtlMs: 15 * MINUTE,
    recentSuccessTtlMs: DEFAULT_POSITION_RESOLVER_POLICY.liveMaxAgeMs,
  });
