// ============================================================================
//  INFRASTRUCTURE · InMemoryCurrentVesselRepository
// ----------------------------------------------------------------------------
//  Cùng hợp đồng với bản Mongo, giữ trong RAM. Dùng cho unit test và cho đường
//  chạy dev không đặt MONGODB_URI.
//
//  CỐ Ý sao chép sâu khi ghi và khi đọc (`structuredClone`, có sẵn từ Node 17):
//  kho thật đi qua ranh giới serialize, nên nếu ở đây trả thẳng tham chiếu thì
//  test "provenance roundtrip" sẽ luôn đúng một cách vô nghĩa — và ta sẽ không
//  bao giờ phát hiện được lỗi mất `Date` hay mất field.
//
//  ⚠️ Mất khi restart. Đúng vai trò: đây không phải kho lưu trữ thật.
// ============================================================================

import {
  CurrentVesselSaveResult,
  CurrentVesselSaveStatus,
  ICurrentVesselRepository,
} from "../../../application/contracts/repositories/ICurrentVesselRepository";
import { currentVesselContentHash } from "../../../application/services/resolution/currentVesselContent";
import { ResolvedCurrentVessel } from "../../../application/services/resolution/ResolvedCurrentVessel";

interface StoredCurrentVessel {
  id: string;
  mmsi: string | null;
  imo: string | null;
  vessel: ResolvedCurrentVessel;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryCurrentVesselRepositoryDeps {
  now?: () => Date;
}

export class InMemoryCurrentVesselRepository implements ICurrentVesselRepository {
  private readonly stored: StoredCurrentVessel[] = [];
  private readonly now: () => Date;
  private nextId = 1;

  constructor(deps: InMemoryCurrentVesselRepositoryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
  }

  async upsert(vessel: ResolvedCurrentVessel): Promise<CurrentVesselSaveResult> {
    if (vessel.vesselKey.mmsi === undefined && vessel.vesselKey.imo === undefined) {
      throw new Error("ResolvedCurrentVessel phải có ít nhất một trong MMSI hoặc IMO");
    }

    const contentHash = currentVesselContentHash(vessel);
    const now = this.now();
    const existing = this.locate(vessel.vesselKey.mmsi, vessel.vesselKey.imo);

    if (existing === null) {
      const record: StoredCurrentVessel = {
        id: String(this.nextId++),
        mmsi: vessel.vesselKey.mmsi ?? null,
        imo: vessel.vesselKey.imo ?? null,
        vessel: structuredClone(vessel),
        contentHash,
        createdAt: now,
        updatedAt: now,
      };
      this.stored.push(record);
      return InMemoryCurrentVesselRepository.result(
        CurrentVesselSaveStatus.CREATED,
        record
      );
    }

    if (existing.contentHash === contentHash) {
      // Chỉ `resolvedAt` khác -> KHÔNG ghi gì. `updatedAt` giữ nguyên, đó là
      // cách người đọc phân biệt "vẫn thế" với "vừa đổi".
      return InMemoryCurrentVesselRepository.result(
        CurrentVesselSaveStatus.UNCHANGED,
        existing
      );
    }

    existing.vessel = structuredClone(vessel);
    existing.contentHash = contentHash;
    existing.updatedAt = now;
    // Khoá canonical chỉ được BỔ SUNG, không xoá: một lần resolve bằng MMSI
    // không được làm mất IMO mà lần trước đã biết.
    existing.mmsi = vessel.vesselKey.mmsi ?? existing.mmsi;
    existing.imo = vessel.vesselKey.imo ?? existing.imo;

    return InMemoryCurrentVesselRepository.result(CurrentVesselSaveStatus.UPDATED, existing);
  }

  async findByMmsi(mmsi: string): Promise<ResolvedCurrentVessel | null> {
    const found = this.stored.find((record) => record.mmsi === mmsi);
    return found === undefined ? null : structuredClone(found.vessel);
  }

  async findByImo(imo: string): Promise<ResolvedCurrentVessel | null> {
    const found = this.stored.find((record) => record.imo === imo);
    return found === undefined ? null : structuredClone(found.vessel);
  }

  /** Chỉ dùng cho test/kiểm tra — không nằm trong port. */
  get size(): number {
    return this.stored.length;
  }

  /**
   * Tra bằng ĐỊNH DANH CHÍNH XÁC, không fuzzy. MMSI trước vì đó là khoá tra
   * chính (CANONICAL_CURRENT_STORAGE.md §Khoá).
   *
   * Nhờ vậy resolve bằng MMSI lần này và bằng IMO lần khác vẫn rơi vào ĐÚNG
   * một document — không sinh bản trùng.
   */
  private locate(
    mmsi: string | undefined,
    imo: string | undefined
  ): StoredCurrentVessel | null {
    if (mmsi !== undefined) {
      const byMmsi = this.stored.find((record) => record.mmsi === mmsi);
      if (byMmsi !== undefined) return byMmsi;
    }
    if (imo !== undefined) {
      const byImo = this.stored.find((record) => record.imo === imo);
      if (byImo !== undefined) return byImo;
    }
    return null;
  }

  private static result(
    status: CurrentVesselSaveStatus,
    record: StoredCurrentVessel
  ): CurrentVesselSaveResult {
    return {
      status,
      contentHash: record.contentHash,
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
