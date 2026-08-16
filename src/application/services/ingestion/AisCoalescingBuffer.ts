// ============================================================================
//  APPLICATION · AisCoalescingBuffer — hãm vòi rồng AIS trước khi đụng DB
// ----------------------------------------------------------------------------
//      normalizedData (AIS-2)  ->  accept()  ->  [trạng thái MỚI NHẤT / MMSI]
//                                            ->  drainBatch(limit)  ->  mẻ có trần
//
//  Bài toán: AIS toàn cầu phát vài nghìn frame/giây, cùng một con tàu có thể
//  phát 5 vị trí trong 10 giây. Nếu mỗi frame thành một lệnh ghi thì Mongo chết
//  vì khối lượng, mà 4/5 bản ghi kia cũng chẳng ai đọc — thứ map cần là vị trí
//  MỚI NHẤT.
//
//  ⛔ KHÔNG Mongo · KHÔNG ObservationRecorder · KHÔNG resolver · KHÔNG mạng ·
//     KHÔNG timer (timer là việc của coordinator) · KHÔNG giữ frame thô ·
//     KHÔNG mảng lịch sử vị trí.
//
//  ⚠️ ĐÂY KHÔNG PHẢI RESOLVER. Buffer không hợp nhất identity với position,
//     không so nguồn này với nguồn kia. Nó chỉ giữ "AIS vừa nói gì" theo NHÓM.
//
//  ⚠️ ĐÂY KHÔNG PHẢI LỊCH SỬ HÀNH TRÌNH. Điểm trung gian bị bỏ CÓ CHỦ Ý —
//     xem docs/AIS_COALESCING_BUFFER.md §"Vì sao bỏ điểm trung gian".
// ============================================================================

import { ProviderDetailsResult } from "../../contracts/providers/ProviderResults";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";

/** Application-owned input accepted from an AIS transport adapter. */
export interface AisIngestionEvent {
  readonly result: ProviderDetailsResult;
  readonly mmsi: string;
}

// ---------------------------------------------------------------------------
//  Đầu ra
// ---------------------------------------------------------------------------

/**
 * Một tàu trong mẻ.
 *
 * Kế thừa `ProviderDetailsResult` là CỐ Ý: AIS-4 đưa thẳng object này vào
 * `detailsResultToObservations()` mà không cần lớp chuyển đổi nào.
 * `particulars`/`voyage` luôn vắng — đường truyền Marine không mang hai nhóm đó.
 */
export interface AisCoalescedEntry extends ProviderDetailsResult {
  readonly mmsi: string;
}

export interface AisCoalescedBatch {
  readonly entries: readonly AisCoalescedEntry[];
  readonly createdAt: Date;
  /** Số tàu CÒN chờ drain sau mẻ này. > 0 nghĩa là phải gọi tiếp. */
  readonly remaining: number;
}

// ---------------------------------------------------------------------------
//  Đếm
// ---------------------------------------------------------------------------

export interface AisCoalescingStats {
  readonly acceptedEvents: number;
  readonly positionEvents: number;
  readonly identityEvents: number;
  /** Vị trí mới ĐÈ lên vị trí đang chờ/đã biết (mốc nguồn mới hơn). */
  readonly positionReplaced: number;
  /** Frame tới SAU nhưng mốc nguồn CŨ HƠN -> bỏ. */
  readonly olderPositionIgnored: number;
  /** Cùng mốc nguồn -> cùng một bản tin AIS phát lại. */
  readonly positionDuplicates: number;
  /** Identity giống hệt cái đã biết -> không tạo việc mới. */
  readonly identityDuplicates: number;
  readonly flushes: number;
  readonly flushedEntries: number;
  readonly evictions: number;
  /** Entry bị đuổi khi CÒN dữ liệu chưa drain — đây là mất dữ liệu thật. */
  readonly evictedDirty: number;
  /** Event không dùng được (thiếu MMSI, không có nhóm nào). */
  readonly rejectedEvents: number;
  readonly currentBufferedVessels: number;
  readonly maxObservedBufferedVessels: number;
  readonly pendingVessels: number;
}

// ---------------------------------------------------------------------------
//  Trạng thái trong buffer
// ---------------------------------------------------------------------------

/**
 * Một ô nhớ cho MỘT tàu.
 *
 * Hai nhóm giữ RIÊNG (yêu cầu §3): `PositionReport` phát mỗi 2–10 giây còn
 * `ShipStaticData` mỗi ~6 phút. Nhét chung một ô rồi để cái sau đè cái trước sẽ
 * xoá sạch tên tàu chỉ vì nó vừa nhúc nhích.
 *
 * Sau khi drain, `position`/`identity` được thả về null nhưng `lastPositionMs`
 * và `identityFingerprint` Ở LẠI. Đó là toàn bộ lý do entry còn tồn tại khi
 * không có gì chờ: giữ đủ để (a) chặn vị trí đến muộn nhưng cũ hơn, (b) chặn
 * identity lặp — mà KHÔNG phải ôm nguyên object.
 */
interface BufferEntry {
  /** Nhóm B đang chờ drain. Không có gì chờ -> null. */
  position: VesselPositionReport | null;
  /** Nhóm A đang chờ drain. Không có gì chờ -> null. */
  identity: VesselIdentity | null;
  /** Mốc NGUỒN mới nhất từng thấy, kể cả đã drain xong. */
  lastPositionMs: number | null;
  /** Vân tay identity mới nhất từng thấy. Chuỗi ngắn, không phải hash. */
  identityFingerprint: string | null;
}

export interface AisCoalescingBufferOptions {
  /** Trần số tàu giữ trong RAM. Vượt -> đuổi tàu lâu không đụng tới nhất. */
  maxVessels: number;
  /** Trần mặc định cho mỗi lần `drainBatch()`. */
  batchSize: number;
  /** Đồng hồ tiêm được -> `createdAt` của mẻ tất định khi test. */
  now?: () => Date;
}

/**
 * Mốc để so hai báo cáo vị trí.
 *
 * ⚠️ Dùng mốc của NGUỒN, không phải `fetchedAt`. Frame tới sau chưa chắc mới
 * hơn: đường truyền có thể xóc, và AIS-1 đã tách hai mốc chính vì lý do này.
 */
function positionInstantMs(position: VesselPositionReport): number {
  const source = position.metadata.sourceReceivedAt ?? position.receivedAt;
  return source.getTime();
}

/**
 * Vân tay identity: `imo|name|vesselTypeCode`.
 *
 * ⚠️ CỐ Ý không băm mật mã. Đây là hot path của một stream toàn cầu; SHA-256
 * cho mỗi frame là đốt CPU để giải quyết một bài toán không tồn tại — ta chỉ
 * cần biết "có khác cái vừa rồi không", không cần chống va chạm có chủ đích.
 * MMSI không nằm trong vân tay vì nó chính là khoá của ô nhớ.
 */
export function identityFingerprint(identity: VesselIdentity): string {
  return `${identity.imo ?? ""}|${identity.name ?? ""}|${identity.vesselTypeCode ?? ""}`;
}

// ---------------------------------------------------------------------------
//  Buffer
// ---------------------------------------------------------------------------

export class AisCoalescingBuffer {
  private readonly maxVessels: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  /**
   * ⚠️ THỨ TỰ CHÈN CỦA `Map` LÀ CƠ CHẾ ĐUỔI, không phải chi tiết ngẫu nhiên.
   * Mỗi lần `accept` một tàu, ô của nó bị `delete` rồi `set` lại -> nhảy xuống
   * CUỐI. Nên khoá ĐẦU TIÊN luôn là tàu lâu nhất chưa đụng tới, và
   * `keys().next()` cho ra nạn nhân trong O(1). Không cần package LRU nào.
   */
  private readonly entries = new Map<string, BufferEntry>();

  /**
   * MMSI đang có dữ liệu chờ drain. Chỉ chứa KHOÁ, và luôn là tập con của
   * `entries` -> có trần theo đúng `maxVessels`, không phải map thứ hai vô hạn.
   * Thứ tự chèn của `Set` khiến drain thành FIFO: tàu chờ lâu nhất đi trước.
   */
  private readonly pending = new Set<string>();

  /**
   * Con trỏ đuổi, DÙNG LẠI qua nhiều lần đuổi.
   *
   * ⚠️ Đây không phải vi tối ưu — nó là khác biệt 94 LẦN, đo được.
   * `entries.keys().next()` trông như O(1) nhưng KHÔNG phải: mỗi lần gọi dựng
   * một iterator MỚI từ đầu bảng, mà đầu bảng của V8 `OrderedHashMap` lại đầy ô
   * đã xoá (mỗi lần "touch" là một delete). Iterator phải bỏ qua từng ô chết
   * một -> chi phí tăng theo số lần đã đuổi, tức là bậc hai.
   *
   *   400k sự kiện / trần 50k, đo trên máy dev:
   *      keys().next() mỗi lần đuổi ....... 10.682 ms
   *      iterator dùng lại ................    114 ms
   *      touch không đuổi (đối chứng) .....    144 ms
   *
   * Iterator của `Map` là SỐNG: phần tử thêm sau vẫn được duyệt tới, và phần tử
   * đã xoá không bao giờ được trả ra. Nên giữ nguyên con trỏ là an toàn — nó đi
   * đúng nhịp với số lần đuổi, hết thì dựng lại từ đầu.
   */
  private evictionCursor: IterableIterator<string> | null = null;

  private stats = {
    acceptedEvents: 0,
    positionEvents: 0,
    identityEvents: 0,
    positionReplaced: 0,
    olderPositionIgnored: 0,
    positionDuplicates: 0,
    identityDuplicates: 0,
    flushes: 0,
    flushedEntries: 0,
    evictions: 0,
    evictedDirty: 0,
    rejectedEvents: 0,
    maxObservedBufferedVessels: 0,
  };

  constructor(options: AisCoalescingBufferOptions) {
    if (!Number.isInteger(options.maxVessels) || options.maxVessels < 1) {
      throw new Error(`AisCoalescingBuffer.maxVessels phải là số nguyên >= 1, nhận ${options.maxVessels}`);
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
      throw new Error(`AisCoalescingBuffer.batchSize phải là số nguyên >= 1, nhận ${options.batchSize}`);
    }
    this.maxVessels = options.maxVessels;
    this.batchSize = options.batchSize;
    this.now = options.now ?? (() => new Date());
  }

  // ---- nạp ------------------------------------------------------------------

  /**
   * ĐỒNG BỘ và O(1) trung bình — đây là hot path, mỗi frame AIS đi qua đúng
   * một lần. Không I/O, không `await`, không log, không `JSON.stringify`.
   */
  accept(event: AisIngestionEvent): void {
    const mmsi = event.mmsi;
    const position = event.result.position;
    const identity = event.result.identity;

    if (mmsi === "" || (position === undefined && identity === undefined)) {
      this.stats.rejectedEvents += 1;
      return;
    }

    this.stats.acceptedEvents += 1;
    const entry = this.touch(mmsi);

    if (position !== undefined) {
      this.stats.positionEvents += 1;
      this.applyPosition(mmsi, entry, position);
    }
    if (identity !== undefined) {
      this.stats.identityEvents += 1;
      this.applyIdentity(mmsi, entry, identity);
    }
  }

  /**
   * Vị trí mới thắng CHỈ KHI mốc nguồn mới hơn.
   *
   *   mới hơn  -> thay, đánh dấu chờ drain
   *   cũ hơn   -> BỎ (frame tới muộn nhưng dữ liệu cũ)
   *   bằng nhau-> cùng một bản tin AIS phát lại. Lấy bản tới SAU cho tất định
   *               (§9) nhưng KHÔNG tạo việc mới nếu ô đang sạch (§11).
   *
   * Mốc `time_utc` của AISStream có độ phân giải nano-giây, nên "bằng nhau"
   * gần như chỉ xảy ra khi đúng là một bản tin bị phát lại. Vì thế ở đây KHÔNG
   * dựng chuỗi vân tay cho vị trí: tránh hẳn một lần cấp phát chuỗi mỗi frame
   * trên hot path để đổi lấy một trường hợp biên gần như không tồn tại.
   */
  private applyPosition(
    mmsi: string,
    entry: BufferEntry,
    position: VesselPositionReport
  ): void {
    const instantMs = positionInstantMs(position);
    const lastMs = entry.lastPositionMs;

    if (lastMs !== null) {
      if (instantMs < lastMs) {
        this.stats.olderPositionIgnored += 1;
        return;
      }
      if (instantMs === lastMs) {
        this.stats.positionDuplicates += 1;
        // Ô đang chờ drain -> thay bằng bản tới sau, vẫn đúng một đơn vị việc.
        // Ô đã sạch -> không đánh dấu chờ lại, nếu không mỗi lần phát lại sẽ
        // sinh thêm một lệnh ghi cho cùng một dữ liệu.
        if (entry.position !== null) entry.position = position;
        return;
      }
      this.stats.positionReplaced += 1;
    }

    entry.position = position;
    entry.lastPositionMs = instantMs;
    this.pending.add(mmsi);
  }

  /**
   * `ShipStaticData` phát lặp lại cùng một nội dung mỗi ~6 phút cho mọi tàu.
   * Đẩy hết xuống DB là tự tạo lũ bản ghi trùng, nên chỉ nội dung ĐỔI mới được
   * xếp hàng.
   */
  private applyIdentity(mmsi: string, entry: BufferEntry, identity: VesselIdentity): void {
    const fingerprint = identityFingerprint(identity);
    if (fingerprint === entry.identityFingerprint) {
      this.stats.identityDuplicates += 1;
      return;
    }

    entry.identity = identity;
    entry.identityFingerprint = fingerprint;
    this.pending.add(mmsi);
  }

  /** Lấy ô, tạo nếu chưa có, và đẩy nó xuống cuối `Map` (đánh dấu vừa dùng). */
  private touch(mmsi: string): BufferEntry {
    const existing = this.entries.get(mmsi);
    if (existing !== undefined) {
      // delete + set = chuyển xuống cuối thứ tự chèn. Đây LÀ phép "touch" của LRU.
      this.entries.delete(mmsi);
      this.entries.set(mmsi, existing);
      return existing;
    }

    const entry: BufferEntry = {
      position: null,
      identity: null,
      lastPositionMs: null,
      identityFingerprint: null,
    };
    this.entries.set(mmsi, entry);
    this.evictIfNeeded(mmsi);
    if (this.entries.size > this.stats.maxObservedBufferedVessels) {
      this.stats.maxObservedBufferedVessels = this.entries.size;
    }
    return entry;
  }

  /**
   * Trần bộ nhớ là YÊU CẦU, không phải tối ưu. Vượt -> đuổi tàu lâu nhất chưa
   * đụng tới. `keys().next()` là O(1) nhờ thứ tự chèn của `Map`.
   *
   * ⚠️ Đuổi một ô CÒN dữ liệu chờ = mất dữ liệu thật. Không giấu: đếm riêng
   * `evictedDirty` để vận hành thấy trần đang bị chạm.
   */
  private evictIfNeeded(protectedKey: string): void {
    while (this.entries.size > this.maxVessels) {
      const key = this.nextEvictionKey(protectedKey);
      if (key === null) return;

      const victim = this.entries.get(key);
      if (victim !== undefined && (victim.position !== null || victim.identity !== null)) {
        this.stats.evictedDirty += 1;
      }
      this.entries.delete(key);
      this.pending.delete(key);
      this.stats.evictions += 1;
    }
  }

  /**
   * Nạn nhân tiếp theo: tàu lâu nhất chưa đụng tới.
   *
   * @param protectedKey tàu VỪA được nạp trong chính lời gọi này — đuổi nó là
   *        vứt đi đúng dữ liệu mới nhất. Gặp thì dựng lại con trỏ từ đầu bảng.
   * @returns null khi không còn ai để đuổi ngoài `protectedKey`.
   */
  private nextEvictionKey(protectedKey: string): string | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.evictionCursor === null) this.evictionCursor = this.entries.keys();

      const next = this.evictionCursor.next();
      // Hết bảng, hoặc trúng khoá vừa nạp -> dựng lại từ đầu và thử một lần nữa.
      if (next.done === true || next.value === protectedKey) {
        this.evictionCursor = null;
        continue;
      }
      return next.value;
    }
    return null;
  }

  // ---- rút ------------------------------------------------------------------

  /**
   * Rút TỐI ĐA `limit` tàu đang có dữ liệu chờ.
   *
   * ⚠️ Chỉ xoá đúng những gì đã đưa ra. Phần dư Ở LẠI hàng chờ — gọi lại tới
   * khi `remaining === 0`. Đây là điều kiện §21: 20.000 tàu với mẻ 500 phải ra
   * 40 mẻ, không phải 1 mẻ rồi xoá sạch 19.500 tàu còn lại.
   *
   * @returns null khi không có gì chờ.
   */
  drainBatch(limit: number = this.batchSize): AisCoalescedBatch | null {
    if (this.pending.size === 0) return null;
    const size = Math.max(1, Math.floor(limit));

    const entries: AisCoalescedEntry[] = [];
    for (const mmsi of this.pending) {
      if (entries.length >= size) break;

      const entry = this.entries.get(mmsi);
      if (entry === undefined) {
        // Bị đuổi giữa chừng — dọn khoá mồ côi rồi đi tiếp.
        this.pending.delete(mmsi);
        continue;
      }

      const drained: AisCoalescedEntry = { mmsi };
      if (entry.position !== null) drained.position = entry.position;
      if (entry.identity !== null) drained.identity = entry.identity;
      entries.push(drained);

      // Thả object nhưng GIỮ mốc + vân tay: chúng là thứ chặn vị trí cũ đến
      // muộn và chặn identity lặp ở các vòng sau, mà chỉ tốn 1 số + 1 chuỗi ngắn.
      entry.position = null;
      entry.identity = null;
      this.pending.delete(mmsi);
    }

    if (entries.length === 0) return null;

    this.stats.flushes += 1;
    this.stats.flushedEntries += entries.length;
    return {
      entries: Object.freeze(entries),
      createdAt: this.now(),
      remaining: this.pending.size,
    };
  }

  /**
   * Rút hết, chia thành nhiều mẻ.
   *
   * @param maxBatches trần số mẻ MỘT chu kỳ được rút. Chạm trần thì phần dư ở
   *        lại cho chu kỳ sau — thà chậm còn hơn khoá vòng lặp sự kiện khi
   *        buffer đang phình.
   */
  drainAll(maxBatches = Number.POSITIVE_INFINITY): AisCoalescedBatch[] {
    const batches: AisCoalescedBatch[] = [];
    while (batches.length < maxBatches) {
      const batch = this.drainBatch();
      if (batch === null) break;
      batches.push(batch);
    }
    return batches;
  }

  // ---- quan sát -------------------------------------------------------------

  size(): number {
    return this.entries.size;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  getStats(): AisCoalescingStats {
    return {
      ...this.stats,
      currentBufferedVessels: this.entries.size,
      pendingVessels: this.pending.size,
    };
  }

  /** Xoá sạch trạng thái. Bộ đếm GIỮ NGUYÊN — chúng là số liệu vận hành. */
  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.evictionCursor = null;
  }
}
