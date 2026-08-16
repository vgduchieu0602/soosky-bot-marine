// ============================================================================
//  APPLICATION · Chính sách GIỮ observation bao lâu (retention)
// ----------------------------------------------------------------------------
//  ⚠️ ĐÂY KHÔNG PHẢI DEDUPE. Hai khái niệm khác hẳn nhau, đừng dùng cái này thay
//  cái kia:
//
//    DEDUPE    (ObservationPolicy) — "có GHI THÊM bản giống hệt không?"
//                                    Không xoá gì cả.
//    RETENTION (file này)          — "bản đã ghi được GIỮ bao lâu?"
//                                    Không ảnh hưởng việc có ghi hay không.
//
//  Không import mongoose. File này chỉ trả về một KHOẢNG THỜI GIAN; việc quy ra
//  `expiresAt` và giao cho Mongo TTL là chuyện của tầng persistence.
//
//  Ràng buộc CỨNG khi chỉnh số ở đây: retention phải >= cửa sổ nạp ứng viên của
//  resolver tương ứng, nếu không TTL sẽ xoá mất chính dữ liệu resolver đang cần
//  và canonical bị ghi đè bằng nhóm rỗng. Xem docs/AIS_LOAD_AND_RETENTION.md.
// ============================================================================

import { VesselObservationType } from "../../../domain/entities/VesselObservation";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { VesselSource } from "../../../domain/enums/VesselSource";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface ObservationRetentionConfig {
  /**
   * Bản ghi INVALID chỉ tồn tại để soi parser đã trôi hay chưa. Ngắn nhất bảng,
   * và đó là chủ ý: `RawPayloadPolicy.ON_ERROR` khiến đúng những bản ghi này
   * mang theo payload thô — tức là nhóm NẶNG nhất trong collection.
   */
  readonly invalidMs: number;
  /** Mặc định theo nhóm dữ liệu. `null` = giữ vô thời hạn. */
  readonly byType: Readonly<Record<VesselObservationType, number | null>>;
  /**
   * Ghi đè cho một (nguồn, nhóm) cụ thể. Cố ý là một BẢNG TRA, không phải
   * rules engine: cần thêm luật thì thêm một dòng, không phải thêm một tầng.
   */
  readonly bySourceAndType: Readonly<
    Partial<Record<VesselSource, Partial<Record<VesselObservationType, number | null>>>>
  >;
}

/**
 * Số mặc định. Mỗi con số đều buộc phải trả lời được "vì sao" — xem tài liệu.
 *
 *   POSITION   7 ngày  = đúng `PositionResolverPolicy.candidateWindowMs`.
 *   VOYAGE    30 ngày  > cửa sổ resolver 7 ngày, thừa chỗ cho phase voyage sau.
 *   IDENTITY  90 ngày  = đúng `IdentityResolverPolicy.candidateWindowMs`.
 *   PARTICULARS 90 ngày = đúng `ParticularsResolverPolicy.candidateWindowMs`.
 *
 *   AISSTREAM + POSITION → 48 GIỜ, ngoại lệ DUY NHẤT và là lý do file này tồn tại.
 *     • AIS toàn cầu sinh tới ~8.600 vị trí/tàu/ngày sau khi gộp cửa sổ 10 giây.
 *       Giữ 7 ngày cho nhóm này là nhân khối lượng lên 3,5 lần cho dữ liệu mà
 *       không ai đọc.
 *     • Hệ thống ĐÃ coi vị trí quá 24 giờ là hết hạn (`POSITION_STALE_AFTER_MS`),
 *       nên 48 giờ vẫn còn gấp đôi biên so với ngưỡng sản phẩm.
 *     • Không chọn đúng 24 giờ: TTL của Mongo chạy nền, có độ trễ, và một vị trí
 *       vừa chạm ngưỡng vẫn nên còn đó khi resolver hỏi tới.
 */
export const DEFAULT_OBSERVATION_RETENTION_CONFIG: ObservationRetentionConfig = Object.freeze({
  invalidMs: 7 * DAY,
  byType: Object.freeze({
    [VesselObservationType.POSITION]: 7 * DAY,
    [VesselObservationType.IDENTITY]: 90 * DAY,
    [VesselObservationType.PARTICULARS]: 90 * DAY,
    [VesselObservationType.VOYAGE]: 30 * DAY,
  }),
  bySourceAndType: Object.freeze({
    [VesselSource.AISSTREAM]: Object.freeze({
      [VesselObservationType.POSITION]: 48 * HOUR,
    }),
  }),
});

export interface ObservationRetentionInput {
  readonly source: VesselSource;
  readonly type: VesselObservationType;
  readonly validationStatus: ObservationValidationStatus;
}

/**
 * Thứ tự ưu tiên — cố định, đọc từ trên xuống:
 *   1. INVALID          -> cửa sổ debug ngắn, bất kể nguồn/nhóm.
 *   2. (nguồn, nhóm)    -> ghi đè riêng.
 *   3. nhóm             -> mặc định.
 *
 * ⚠️ PARTIAL KHÔNG bị rút ngắn: lõi của nó vẫn dùng được và resolver vẫn nhận
 * (`includeInvalid` chỉ chặn INVALID). Xoá sớm là xoá dữ liệu đang có người dùng.
 *
 * @returns số ms giữ lại, hoặc `null` = giữ vô thời hạn.
 */
export function retentionMsFor(
  input: ObservationRetentionInput,
  config: ObservationRetentionConfig = DEFAULT_OBSERVATION_RETENTION_CONFIG
): number | null {
  if (input.validationStatus === ObservationValidationStatus.INVALID) {
    return config.invalidMs;
  }

  const override = config.bySourceAndType[input.source]?.[input.type];
  if (override !== undefined) return override;

  return config.byType[input.type];
}

/**
 * Mốc hết hạn của một bản ghi.
 *
 * ⚠️ Tính từ `fetchedAt` (đồng hồ BOT, LUÔN có) chứ không phải `sourceReceivedAt`
 * (có thể null, và có thể trễ hàng giờ như ShipInfo). Retention là vòng đời của
 * BẢN GHI trong kho của ta, không phải tuổi của dữ liệu nguồn.
 *
 * @returns `null` khi giữ vô thời hạn -> tầng persistence KHÔNG ghi `expiresAt`,
 *          và TTL index của Mongo bỏ qua document thiếu field đó.
 */
export function observationExpiresAt(
  input: ObservationRetentionInput & { fetchedAt: Date },
  config: ObservationRetentionConfig = DEFAULT_OBSERVATION_RETENTION_CONFIG
): Date | null {
  const retentionMs = retentionMsFor(input, config);
  if (retentionMs === null) return null;
  return new Date(input.fetchedAt.getTime() + retentionMs);
}
