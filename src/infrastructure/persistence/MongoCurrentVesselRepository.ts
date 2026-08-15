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
} from "../../application/current/ICurrentVesselRepository";
import { currentVesselContentHash } from "../../application/current/currentVesselContent";
import { ResolvedCurrentVessel } from "../../application/resolver/ResolvedCurrentVessel";
import { CurrentVesselModel } from "./mongoose/currentVesselModel";

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
}

export class MongoCurrentVesselRepository implements ICurrentVesselRepository {
  async upsert(vessel: ResolvedCurrentVessel): Promise<CurrentVesselSaveResult> {
    const { mmsi, imo } = vessel.vesselKey;
    if (mmsi === undefined && imo === undefined) {
      throw new Error("ResolvedCurrentVessel phải có ít nhất một trong MMSI hoặc IMO");
    }

    const contentHash = currentVesselContentHash(vessel);
    const existing = await this.locate(mmsi, imo);

    if (existing === null) {
      const created = await CurrentVesselModel.create(
        MongoCurrentVesselRepository.toDoc(vessel, contentHash)
      );
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
    doc.imo = imo ?? existing.imo ?? null;

    const updated = await CurrentVesselModel.findByIdAndUpdate(
      existing._id,
      { $set: doc },
      { new: true }
    ).lean<CurrentVesselDoc>();

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
    if (imo !== undefined) {
      const byImo = await CurrentVesselModel.findOne({ imo }).lean<CurrentVesselDoc>();
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
      imo: vessel.vesselKey.imo ?? null,
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
