// ============================================================================
//  APPLICATION · USE CASE: ResolveCurrentVessel — ghép bốn nhóm
// ----------------------------------------------------------------------------
//      vesselKey
//        -> 4 truy vấn "mới nhất mỗi nguồn" (IDENTITY/POSITION/PARTICULARS/VOYAGE)
//        -> 4 resolver
//        -> ResolvedCurrentVessel | null
//
//  Chỉ ĐỌC: không mạng, không provider, không runtime, không ghi DB, không
//  fallback. Use case này trả kết quả về cho người gọi; `ResolveAndStoreCurrentVessel`
//  mới là chỗ ghi xuống `canonical_current_vessels`.
//
//  Bốn truy vấn riêng là CHẤP NHẬN ĐƯỢC ở phase này: mỗi truy vấn đã bị chặn
//  bởi SỐ NGUỒN (hiện 3), và bốn nhóm có cửa sổ thời gian KHÁC NHAU (position
//  7 ngày, voyage 7 ngày, identity/particulars 90 ngày) nên gộp thành một
//  aggregate sẽ phải mã hoá bốn cửa sổ vào một câu truy vấn — phức tạp hơn mà
//  không mua được gì. Chạy song song nên chỉ tốn một lượt chờ.
//
//  Tầng này KHÔNG phân xử gì cả. Nó không biết luật của nhóm nào.
// ============================================================================

import { IVesselObservationRepository } from "../../contracts/repositories/IVesselObservationRepository";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import { VesselObservationKey } from "../../../domain/entities/VesselObservation";
import { normalizeImo, normalizeMmsi } from "../../../domain/validators/identifiers";
import { ResolveCurrentIdentity } from "./ResolveCurrentIdentity";
import { ResolveCurrentParticulars } from "./ResolveCurrentParticulars";
import { ResolveCurrentPosition } from "./ResolveCurrentPosition";
import { ResolveCurrentVoyage } from "./ResolveCurrentVoyage";

export interface ResolveCurrentVesselDeps {
  repository: IVesselObservationRepository;
  now?: () => Date;
  /** Tiêm được để test; mặc định dựng từ `repository`. */
  identity?: ResolveCurrentIdentity;
  position?: ResolveCurrentPosition;
  particulars?: ResolveCurrentParticulars;
  voyage?: ResolveCurrentVoyage;
}

export class ResolveCurrentVessel {
  private readonly now: () => Date;
  private readonly identity: ResolveCurrentIdentity;
  private readonly position: ResolveCurrentPosition;
  private readonly particulars: ResolveCurrentParticulars;
  private readonly voyage: ResolveCurrentVoyage;

  constructor(deps: ResolveCurrentVesselDeps) {
    const { repository } = deps;
    this.now = deps.now ?? (() => new Date());
    const now = this.now;

    this.identity = deps.identity ?? new ResolveCurrentIdentity({ repository, now });
    this.position = deps.position ?? new ResolveCurrentPosition({ repository, now });
    this.particulars = deps.particulars ?? new ResolveCurrentParticulars({ repository, now });
    this.voyage = deps.voyage ?? new ResolveCurrentVoyage({ repository, now });
  }

  /**
   * @returns null khi KHÔNG nhóm nào phân xử được gì. Chỉ cần một nhóm có kết
   *          quả là trả về read model — tàu chỉ có identity mà chưa có vị trí
   *          vẫn là dữ liệu dùng được.
   */
  async execute(key: VesselObservationKey): Promise<ResolvedCurrentVessel | null> {
    // Bốn nhóm độc lập, không nhóm nào là đầu vào của nhóm nào -> chạy song song.
    const [identity, position, particulars, voyage] = await Promise.all([
      this.identity.execute(key),
      this.position.execute(key),
      this.particulars.execute(key),
      this.voyage.execute(key),
    ]);

    if (identity === null && position === null && particulars === null && voyage === null) {
      return null;
    }

    return {
      vesselKey: ResolveCurrentVessel.buildKey(key, identity?.imo?.value),
      identity,
      position,
      particulars,
      voyage,
      // Thời điểm CHẠY resolve, không phải max(fetchedAt) của observation.
      resolvedAt: this.now(),
    };
  }

  /**
   * Giữ nguyên định danh người gọi đưa vào. Chỉ BỔ SUNG `imo` khi khoá gốc
   * chưa có và identity phân xử được — không bao giờ ghi đè giá trị đã yêu cầu.
   *
   * ĐÂY là ranh giới observation -> CANONICAL, nên cũng là chỗ định danh phải
   * hợp lệ thật. Observation vẫn giữ nguyên giá trị thô kèm issue để debug
   * parser; nhưng khoá canonical thì `"0"` phải trở thành "không có IMO".
   */
  private static buildKey(
    key: VesselObservationKey,
    resolvedImo: string | undefined
  ): { mmsi?: string; imo?: string } {
    return {
      mmsi: normalizeMmsi(key.mmsi) ?? undefined,
      imo: normalizeImo(key.imo ?? resolvedImo) ?? undefined,
    };
  }
}
