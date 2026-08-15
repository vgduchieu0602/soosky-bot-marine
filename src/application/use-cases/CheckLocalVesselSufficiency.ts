// ============================================================================
//  APPLICATION · USE CASE: CheckLocalVesselSufficiency
// ----------------------------------------------------------------------------
//      khoá tàu + DataNeed
//        -> ICurrentVesselRepository (ĐỌC canonical_current_vessels)
//        -> LocalDataSufficiencyChecker
//        -> SufficiencyResult
//
//  ⛔ KHÔNG mạng, KHÔNG provider, KHÔNG runtime, KHÔNG capability matrix,
//  KHÔNG ghi gì. Đây là đầu "local-first" của luồng acquisition
//  (ACQUISITION_POLICY.md §B) và nó DỪNG TRƯỚC ranh giới mạng.
//
//  Không tìm thấy tàu -> KHÔNG phải lỗi: `NO_CURRENT_VESSEL` là một câu trả lời
//  hợp lệ về thế giới ("ta chưa có gì về con tàu này"), và đó chính là tín hiệu
//  P9.3 cần để quyết định đi lấy.
// ============================================================================

import {
  ICurrentVesselRepository,
} from "../current/ICurrentVesselRepository";
import { ResolvedCurrentVessel } from "../resolver/ResolvedCurrentVessel";
import { VesselObservationKey } from "../../domain/observations/VesselObservation";
import { DataNeed } from "../acquisition/DataNeed";
import { LocalDataSufficiencyChecker } from "../acquisition/LocalDataSufficiencyChecker";
import { SufficiencyResult } from "../acquisition/SufficiencyTypes";

export interface CheckLocalVesselSufficiencyDeps {
  repository: ICurrentVesselRepository;
  checker?: LocalDataSufficiencyChecker;
  now?: () => Date;
}

export class CheckLocalVesselSufficiency {
  private readonly repository: ICurrentVesselRepository;
  private readonly checker: LocalDataSufficiencyChecker;
  private readonly now: () => Date;

  constructor(deps: CheckLocalVesselSufficiencyDeps) {
    this.repository = deps.repository;
    this.checker = deps.checker ?? new LocalDataSufficiencyChecker();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * @throws Error khi khoá rỗng — không truy vấn với khoá không định danh được
   *         con tàu nào; đó là lỗi người gọi, không phải "chưa có dữ liệu".
   * @throws InvalidDataNeedError khi need sai hình dạng (checker kiểm).
   */
  async execute(key: VesselObservationKey, need: DataNeed): Promise<SufficiencyResult> {
    const vessel = await this.lookup(key);
    // Đọc đồng hồ MỘT LẦN cho cả lượt kiểm: hai field so với hai mốc `now` khác
    // nhau có thể cho kết quả không nhất quán.
    return this.checker.check(vessel, need, this.now());
  }

  /**
   * MMSI trước, rồi IMO — cùng thứ tự với `ICurrentVesselRepository` (P8.5),
   * nên tra bằng khoá nào cũng rơi vào đúng một document.
   */
  private async lookup(key: VesselObservationKey): Promise<ResolvedCurrentVessel | null> {
    // Kiểm TRƯỚC, không truy vấn rồi mới phát hiện: khoá rỗng không định danh
    // được con tàu nào, mọi câu truy vấn từ nó đều vô nghĩa.
    if (key.mmsi === undefined && key.imo === undefined) {
      throw new Error("VesselObservationKey phải có ít nhất một trong MMSI hoặc IMO");
    }

    if (key.mmsi !== undefined) {
      const byMmsi = await this.repository.findByMmsi(key.mmsi);
      if (byMmsi !== null) return byMmsi;
    }
    if (key.imo !== undefined) {
      return this.repository.findByImo(key.imo);
    }
    return null;
  }
}
