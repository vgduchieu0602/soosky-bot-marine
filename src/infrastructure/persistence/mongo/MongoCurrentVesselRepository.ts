// ============================================================================
//  INFRASTRUCTURE · MongoCurrentVesselRepository
// ----------------------------------------------------------------------------
//  Upsert vào `canonical_current_vessels`. KHÔNG đụng vessels / latestpositions /
//  vesselpositions / vessel_observations.
//
//  Trách nhiệm: serialize, deserialize, upsert, tra cứu. HẾT.
//  Không phân xử gì — mọi luật chọn nguồn nằm ở resolver (P8.2–P8.4).
// ============================================================================

import {
  CurrentVesselSaveResult,
  CurrentVesselSaveStatus,
  ICurrentVesselRepository,
} from "../../../application/contracts/repositories/ICurrentVesselRepository";
import { currentVesselContentHash } from "../../../application/services/resolution/currentVesselContent";
import { ResolvedCurrentVessel } from "../../../application/services/resolution/ResolvedCurrentVessel";
import { isValidCoordinates } from "../../../domain/validators/geo";
import { normalizeImo } from "../../../domain/validators/identifiers";
import { CurrentVesselModel } from "./currentVesselModel";

interface CurrentVesselDoc {
  _id?: unknown;
  mmsi?: string | null;
  imo?: string | null;
  identity?: unknown;
  position?: unknown;
  particulars?: unknown;
  voyage?: unknown;
  resolvedAt: Date;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
  location?: GeoJsonPoint;
}

/** Đúng hình dạng GeoJSON mà 2dsphere của Mongo nhận. */
export interface GeoJsonPoint {
  type: "Point";
  /** ⚠️ **[kinh độ, vĩ độ]** — thứ tự GeoJSON, ngược với cách người ta đọc. */
  coordinates: [number, number];
}

/**
 * Phép chiếu canonical -> GeoJSON. HÀM THUẦN, tách ra để test được mà không cần
 * Mongo chạy.
 *
 * ⚠️ Hai điểm chết người, cả hai đều KHÔNG ném lỗi nếu làm sai:
 *   1. Thứ tự phải là `[lng, lat]`. Đảo nhầm thì tàu ở Vũng Tàu (10,107) nhảy
 *      sang (107,10) — giữa Somalia — và Mongo vẫn nhận vì cả hai đều hợp lệ.
 *   2. Toạ độ rác (NaN, lat 91, lng 181) phải bị chặn Ở ĐÂY. Dựng Point từ
 *      chúng sẽ làm hỏng cả lần ghi (Mongo từ chối khoá geo), tức là một con
 *      tàu rác kéo đổ lệnh ghi của chính nó.
 *
 * @returns `null` khi canonical chưa có vị trí, hoặc toạ độ không dùng được.
 */
export function toGeoJsonPoint(vessel: ResolvedCurrentVessel): GeoJsonPoint | null {
  const report = vessel.position?.position;
  if (report === undefined) return null;
  if (!isValidCoordinates(report.lat, report.lng)) return null;
  return { type: "Point", coordinates: [report.lng, report.lat] };
}

export class MongoCurrentVesselRepository implements ICurrentVesselRepository {
  async upsert(vessel: ResolvedCurrentVessel): Promise<CurrentVesselSaveResult> {
    const { mmsi, imo } = vessel.vesselKey;
    if (mmsi === undefined && imo === undefined) {
      throw new Error("ResolvedCurrentVessel phải có ít nhất một trong MMSI hoặc IMO");
    }

    const contentHash = currentVesselContentHash(vessel);
    const location = toGeoJsonPoint(vessel);
    const existing = await this.locate(mmsi, imo);

    if (existing === null) {
      const created = await CurrentVesselModel.create({
        ...MongoCurrentVesselRepository.toDoc(vessel, contentHash),
        // Chỉ gắn khi thật sự có vị trí — 2dsphere bỏ qua document thiếu field.
        ...(location === null ? {} : { location }),
      });
      return {
        status: CurrentVesselSaveStatus.CREATED,
        contentHash,
        id: String(created._id),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    }

    if (existing.contentHash === contentHash) {
      // Chỉ `resolvedAt` khác -> KHÔNG chạm vào document. `updatedAt` giữ
      // nguyên, nên nó vẫn trả lời đúng câu "canonical đổi lần cuối khi nào".
      return {
        status: CurrentVesselSaveStatus.UNCHANGED,
        contentHash,
        id: String(existing._id),
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const doc = MongoCurrentVesselRepository.toDoc(vessel, contentHash);
    // Khoá canonical chỉ được BỔ SUNG, không xoá: resolve bằng MMSI không được
    // làm mất IMO mà bản ghi trước đã biết.
    doc.mmsi = mmsi ?? existing.mmsi ?? null;
    // Lưới cuối cùng ngay trước unique index `imo_1`. Dùng LẠI `normalizeImo`
    // của domain — không phải một luật thứ hai — để một resolved vessel lỗi
    // cũng không thể biến `"0"` thành định danh canonical.
    doc.imo = normalizeImo(imo ?? existing.imo);

    // ⚠️ `location` đi trong CHÍNH lệnh ghi này, không phải một lượt update thứ
    // hai: hai lệnh nghĩa là có một khoảnh khắc canonical và toạ độ nói hai
    // chuyện khác nhau, và nghĩa là gấp đôi số lệnh ghi cho mỗi tàu.
    //
    // Vị trí biến mất -> `$unset`, KHÔNG phải `location: null`. Toạ độ cũ nằm
    // lại là tàu ma: map sẽ vẽ nó ở chỗ nó không còn ở đó nữa.
    const update: Record<string, unknown> =
      location === null
        ? { $set: doc, $unset: { location: "" } }
        : { $set: { ...doc, location } };

    // `returnDocument: "after"` thay cho `new: true` — cùng hành vi (trả về bản
    // ghi SAU khi cập nhật), chỉ là tên hiện hành của driver. Mongoose cảnh báo
    // `new` đã deprecated.
    const updated = await CurrentVesselModel.findByIdAndUpdate(existing._id, update, {
      returnDocument: "after",
    }).lean<CurrentVesselDoc>();

    return {
      status: CurrentVesselSaveStatus.UPDATED,
      contentHash,
      id: String(existing._id),
      createdAt: updated?.createdAt ?? existing.createdAt,
      updatedAt: updated?.updatedAt ?? existing.updatedAt,
    };
  }

  async findByMmsi(mmsi: string): Promise<ResolvedCurrentVessel | null> {
    const doc = await CurrentVesselModel.findOne({ mmsi }).lean<CurrentVesselDoc>();
    return doc === null ? null : MongoCurrentVesselRepository.toEntity(doc);
  }

  async findManyByMmsi(mmsis: readonly string[]): Promise<readonly ResolvedCurrentVessel[]> {
    if (mmsis.length === 0) return Object.freeze([]);
    const docs = await CurrentVesselModel.find({ mmsi: { $in: [...mmsis] } }).lean<CurrentVesselDoc[]>();
    return Object.freeze(docs.map((doc) => MongoCurrentVesselRepository.toEntity(doc)));
  }

  async findByImo(imo: string): Promise<ResolvedCurrentVessel | null> {
    const doc = await CurrentVesselModel.findOne({ imo }).lean<CurrentVesselDoc>();
    return doc === null ? null : MongoCurrentVesselRepository.toEntity(doc);
  }

  /**
   * Tra bằng ĐỊNH DANH CHÍNH XÁC, MMSI trước rồi IMO. Không fuzzy, không so
   * tên/callsign — P8.5 không làm entity resolution.
   *
   * Hai lượt tra riêng thay vì một `$or`: cho kết quả TẤT ĐỊNH khi cả hai khoá
   * cùng có mà lại trỏ tới hai document khác nhau (`$or` để Mongo tự chọn).
   * Trường hợp đó là dữ liệu đã trùng từ trước — P8.5 KHÔNG tự gộp, chỉ chọn
   * ổn định theo MMSI. Gộp bản trùng là việc của phase khác.
   */
  private async locate(
    mmsi: string | undefined,
    imo: string | undefined
  ): Promise<CurrentVesselDoc | null> {
    if (mmsi !== undefined) {
      const byMmsi = await CurrentVesselModel.findOne({ mmsi }).lean<CurrentVesselDoc>();
      if (byMmsi !== null) return byMmsi;
    }
    // Tra theo IMO ĐÃ CHUẨN HOÁ. Nếu dùng giá trị thô, một tàu mang sentinel
    // `imo = "0"` sẽ khớp vào document của MỘT CON TÀU KHÁC cũng đang mang "0"
    // và ghi đè lên nó — mất dữ liệu chứ không chỉ là trùng khoá.
    const normalizedImo = normalizeImo(imo);
    if (normalizedImo !== null) {
      const byImo = await CurrentVesselModel.findOne({ imo: normalizedImo }).lean<CurrentVesselDoc>();
      if (byImo !== null) return byImo;
    }
    return null;
  }

  /**
   * Bốn nhóm đi thẳng vào schema con — mongoose ép kiểu theo
   * `currentVesselModel.ts`. Nhờ đó `Date` (eta, observedAt, fetchedAt,
   * receivedAt trong payload vị trí) được lưu dưới dạng BSON Date, không phải
   * chuỗi ISO.
   */
  private static toDoc(
    vessel: ResolvedCurrentVessel,
    contentHash: string
  ): Record<string, unknown> & { mmsi: string | null; imo: string | null } {
    return {
      mmsi: vessel.vesselKey.mmsi ?? null,
      imo: normalizeImo(vessel.vesselKey.imo),
      identity: vessel.identity,
      position: vessel.position,
      particulars: vessel.particulars,
      voyage: vessel.voyage,
      resolvedAt: vessel.resolvedAt,
      contentHash,
    };
  }

  /**
   * Ép kiểu MỘT LẦN ở ranh giới hạ tầng, cùng cách `MongoVesselObservationRepository`
   * làm. An toàn của phép ép này do schema bảo đảm — và do test schema-coverage
   * canh: thiếu một field trong schema thì mongoose lặng lẽ nuốt nó, ép kiểu ở
   * đây sẽ không kêu.
   */
  private static toEntity(doc: CurrentVesselDoc): ResolvedCurrentVessel {
    return {
      vesselKey: {
        mmsi: doc.mmsi ?? undefined,
        imo: doc.imo ?? undefined,
      },
      identity: doc.identity ?? null,
      position: doc.position ?? null,
      particulars: doc.particulars ?? null,
      voyage: doc.voyage ?? null,
      resolvedAt: doc.resolvedAt,
    } as ResolvedCurrentVessel;
  }
}
