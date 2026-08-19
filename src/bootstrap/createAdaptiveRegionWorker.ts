// ============================================================================
//  BOOTSTRAP · createAdaptiveRegionWorker — Container -> ProductionRuntimeWorker
// ----------------------------------------------------------------------------
//  Đúng một việc: bọc `AdaptiveRegionScheduler` thành một worker mà
//  `ProductionRuntime` biết start/stop.
//
//  MỌI phụ thuộc đều LẤY LẠI từ `Container` (provider registry, crawl runtime,
//  recorder, resolver, repository). Ở đây KHÔNG dựng mới ProviderRegistry,
//  SourceRuntimeManager hay Mongo repository nào — proof script tự dựng bộ của
//  nó là chuyện của proof script, production không được nhân bản wiring đó.
// ============================================================================

import { Container } from "./container";
import { ProductionRuntimeWorker } from "./ProductionRuntime";
import { AdaptiveRegionScheduler } from "../infrastructure/scheduler/AdaptiveRegionScheduler";
import { IntervalScheduler } from "../infrastructure/scheduler/IntervalScheduler";
import { MongoCrawlRegionStateRepository } from "../infrastructure/persistence/mongo/MongoCrawlRegionStateRepository";
import { VesselSource } from "../domain/enums/VesselSource";

/**
 * Nhịp HỎI "có vùng nào tới hạn chưa".
 *
 * ⚠️ ĐÂY KHÔNG PHẢI nhịp quét. Vùng HIGH vẫn là 10–20 phút; con số dưới đây chỉ
 * quyết định bot tỉnh dậy nhìn đồng hồ bao lâu một lần. Khoảng cách quét thật
 * do `crawl_region_states.nextScanAt` + `RegionSchedulePolicy` quyết định.
 *
 * Là hằng số, không phải biến môi trường: không có tình huống vận hành nào cần
 * chỉnh riêng nhịp nhìn đồng hồ.
 */
export const REGION_DUE_CHECK_EVERY_MS = 30_000;

export interface AdaptiveRegionWorkerDeps {
  /** Tiêm được để test không phải dựng Mongo thật. */
  regionStates?: ConstructorParameters<typeof AdaptiveRegionScheduler>[0]["regionStates"];
  dueCheckEveryMs?: number;
}

/**
 * @throws Error khi registry không có provider quét vùng — thà chết lúc khởi
 *         động còn hơn chạy im lặng mà không bao giờ quét được gì.
 */
export function createAdaptiveRegionWorker(
  container: Container,
  deps: AdaptiveRegionWorkerDeps = {}
): ProductionRuntimeWorker {
  const provider = container.providerRegistry.get(VesselSource.VESSELFINDER);
  if (provider?.scanArea === undefined) {
    throw new Error(
      "Adaptive region crawling requires a VesselFinder provider implementing scanArea."
    );
  }

  const scheduler = new AdaptiveRegionScheduler({
    provider,
    runtime: container.crawlRuntime,
    recorder: container.observationRecorder,
    resolveAndStore: container.resolveAndStoreCurrentVessel,
    regionStates: deps.regionStates ?? new MongoCrawlRegionStateRepository(),
    currentVesselRepository: container.currentVesselRepository,
    // `CompleteVesselBasics` đã được dựng sẵn trong canonical dependencies —
    // dùng lại đúng instance đó thay vì lắp lại từ các mảnh rời.
    completeBasics: container.completeVesselBasics,
  });

  const poll = new IntervalScheduler({
    label: "adaptive maritime regions",
    everyMs: deps.dueCheckEveryMs ?? REGION_DUE_CHECK_EVERY_MS,
    task: async () => {
      await scheduler.tick();
    },
  });

  return {
    start: () => poll.start(),
    stop: async () => {
      // Dừng đồng hồ TRƯỚC để không có lượt nào mới bắt đầu, rồi mới báo cho
      // scheduler ngừng nhận vùng tiếp theo. `ProductionRuntime` đóng Mongo sau
      // khi hàm này trả về, nên thứ tự này giữ cho lượt đang chạy còn DB để ghi.
      poll.stop();
      await scheduler.stop();
    },
    stats: () => ({ ...poll.getStats(), regions: scheduler.regionCount() }),
  };
}
