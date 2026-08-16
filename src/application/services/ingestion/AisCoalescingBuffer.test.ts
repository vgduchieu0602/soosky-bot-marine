// ============================================================================
//  TEST · AisCoalescingBuffer
// ----------------------------------------------------------------------------
//  Buffer là state thuần: không timer, không mạng, không DB -> test gọi thẳng
//  `accept()` / `drainBatch()`, không chờ đồng hồ một mili-giây nào.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselIdentity } from "../../../domain/value-objects/VesselIdentity";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../../domain/enums/VesselSource";
import {
  AisCoalescingBuffer,
  AisIngestionEvent,
  identityFingerprint,
} from "./AisCoalescingBuffer";

const FETCHED_AT = new Date("2026-08-16T12:10:00.000Z");
const CREATED_AT = new Date("2026-08-16T12:10:05.000Z");

function at(hhmmss: string): Date {
  return new Date(`2026-08-16T${hhmmss}.000Z`);
}

function positionEvent(
  mmsi: string,
  sourceReceivedAt: Date,
  overrides: Partial<VesselPositionReport> = {}
): AisIngestionEvent {
  const position: VesselPositionReport = {
    mmsi,
    imo: null,
    lat: 33.7,
    lng: -118.2,
    speed: 10,
    course: 120,
    heading: null,
    navStatus: { code: 0, text: "Under way using engine" },
    latLngApproximate: false,
    receivedAt: sourceReceivedAt,
    metadata: createSourceMetadata({
      source: VesselSource.AISSTREAM,
      fetchedAt: FETCHED_AT,
      sourceReceivedAt,
    }),
    ...overrides,
  };
  return { result: { position }, mmsi };
}

function identityEvent(
  mmsi: string,
  overrides: Partial<VesselIdentity> = {}
): AisIngestionEvent {
  const identity: VesselIdentity = {
    mmsi,
    imo: "9074729",
    name: "AGIA DOXA",
    callsign: null,
    vesselType: null,
    vesselTypeCode: 70,
    flag: null,
    metadata: createSourceMetadata({
      source: VesselSource.AISSTREAM,
      fetchedAt: FETCHED_AT,
      sourceReceivedAt: null,
    }),
    ...overrides,
  };
  return { result: { identity }, mmsi };
}

function buildBuffer(maxVessels = 100, batchSize = 500): AisCoalescingBuffer {
  return new AisCoalescingBuffer({ maxVessels, batchSize, now: () => CREATED_AT });
}

/** Rút hết rồi gộp thành một mảng entry — tiện cho assert. */
function drainEntries(buffer: AisCoalescingBuffer, limit?: number) {
  const batches = limit === undefined ? buffer.drainAll() : [];
  if (limit !== undefined) {
    let batch = buffer.drainBatch(limit);
    while (batch !== null) {
      batches.push(batch);
      batch = buffer.drainBatch(limit);
    }
  }
  return batches.flatMap((batch) => batch.entries);
}

// ---------------------------------------------------------------------------
//  §2 · Gộp cùng một tàu
// ---------------------------------------------------------------------------

test("§2 nhiều vị trí cùng MMSI trong một cửa sổ -> chỉ MỘT entry, bản mới nhất", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("636018086", at("12:00:01"), { lat: 1 }));
  buffer.accept(positionEvent("636018086", at("12:00:03"), { lat: 2 }));
  buffer.accept(positionEvent("636018086", at("12:00:06"), { lat: 3 }));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mmsi, "636018086");
  assert.equal(entries[0].position?.lat, 3);
  assert.equal(buffer.getStats().positionReplaced, 2);
});

// ---------------------------------------------------------------------------
//  §27 · Vị trí tới muộn nhưng CŨ hơn
// ---------------------------------------------------------------------------

test("§27 frame tới sau nhưng mốc NGUỒN cũ hơn -> bỏ, giữ bản mới hơn", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:10:00"), { lat: 10 }));
  buffer.accept(positionEvent("A100", at("12:09:00"), { lat: 9 }));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].position?.lat, 10, "12:10 phải thắng");
  assert.equal(entries[0].position?.receivedAt.toISOString(), at("12:10:00").toISOString());

  const stats = buffer.getStats();
  assert.equal(stats.olderPositionIgnored, 1);
  assert.equal(stats.positionReplaced, 0);
});

test("mốc nguồn CŨ hơn vẫn bị chặn sau khi đã drain", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:10:00"), { lat: 10 }));
  assert.equal(drainEntries(buffer).length, 1);

  // Ô đã sạch nhưng vẫn nhớ mốc -> frame cũ không được hồi sinh.
  buffer.accept(positionEvent("A100", at("12:09:00"), { lat: 9 }));
  assert.equal(buffer.drainBatch(), null);
  assert.equal(buffer.getStats().olderPositionIgnored, 1);
});

// ---------------------------------------------------------------------------
//  §28 · Thay thế
// ---------------------------------------------------------------------------

test("§28 mốc nguồn mới hơn -> thay, positionReplaced tăng", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:09:00")));
  buffer.accept(positionEvent("A100", at("12:10:00")));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].position?.receivedAt.toISOString(), at("12:10:00").toISOString());
  assert.equal(buffer.getStats().positionReplaced, 1);
});

test("§9 cùng mốc nguồn -> đếm trùng, KHÔNG tạo thêm việc", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:10:00"), { lat: 1 }));
  // Đang chờ drain -> bản tới sau thắng (tất định), vẫn đúng một đơn vị việc.
  buffer.accept(positionEvent("A100", at("12:10:00"), { lat: 2 }));

  assert.equal(buffer.pendingCount(), 1);
  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].position?.lat, 2);
  assert.equal(buffer.getStats().positionDuplicates, 1);

  // Đã sạch rồi mà nguồn phát lại đúng mốc đó -> KHÔNG bẩn lại.
  buffer.accept(positionEvent("A100", at("12:10:00"), { lat: 3 }));
  assert.equal(buffer.pendingCount(), 0);
  assert.equal(buffer.drainBatch(), null);
  assert.equal(buffer.getStats().positionDuplicates, 2);
});

// ---------------------------------------------------------------------------
//  §29 · Nhiều MMSI
// ---------------------------------------------------------------------------

test("§29 A1 B1 A2 C1 -> A2 B1 C1", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A00000001", at("12:00:01"), { lat: 1 }));
  buffer.accept(positionEvent("B00000001", at("12:00:02"), { lat: 11 }));
  buffer.accept(positionEvent("A00000001", at("12:00:03"), { lat: 2 }));
  buffer.accept(positionEvent("C00000001", at("12:00:04"), { lat: 21 }));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 3);
  const byMmsi = new Map(entries.map((entry) => [entry.mmsi, entry.position?.lat]));
  assert.equal(byMmsi.get("A00000001"), 2);
  assert.equal(byMmsi.get("B00000001"), 11);
  assert.equal(byMmsi.get("C00000001"), 21);
});

// ---------------------------------------------------------------------------
//  §3 + §30 · Position và Static TÁCH NHAU
// ---------------------------------------------------------------------------

test("§30 cùng MMSI có cả position lẫn identity -> một entry, đủ hai nhóm", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:00:01")));
  buffer.accept(identityEvent("A100"));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0].position, undefined);
  assert.notEqual(entries[0].identity, undefined);
  assert.equal(entries[0].identity?.name, "AGIA DOXA");
  // Buffer KHÔNG hợp nhất hai nhóm — đó là việc của resolver.
  assert.equal(entries[0].position?.mmsi, "A100");
});

test("§3 Position → Position → Static → Position: flush vẫn có CẢ HAI nhóm mới nhất", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:00:01"), { lat: 1 }));
  buffer.accept(positionEvent("A100", at("12:00:02"), { lat: 2 }));
  buffer.accept(identityEvent("A100", { name: "SHIP ONE" }));
  buffer.accept(positionEvent("A100", at("12:00:04"), { lat: 4 }));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].position?.lat, 4, "vị trí mới nhất");
  assert.equal(entries[0].identity?.name, "SHIP ONE", "identity KHÔNG bị vị trí đè mất");
});

// ---------------------------------------------------------------------------
//  §31 + §32 · Identity trùng / đổi
// ---------------------------------------------------------------------------

test("§31 identity giống hệt gửi hai lần -> chỉ MỘT lần ra, đếm trùng", () => {
  const buffer = buildBuffer();
  buffer.accept(identityEvent("A100"));
  buffer.accept(identityEvent("A100"));

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(buffer.getStats().identityDuplicates, 1);

  // Phát lại sau khi đã drain cũng không sinh việc mới.
  buffer.accept(identityEvent("A100"));
  assert.equal(buffer.drainBatch(), null);
  assert.equal(buffer.getStats().identityDuplicates, 2);
});

test("§32 identity ĐỔI tên -> bản mới được phát ra", () => {
  const buffer = buildBuffer();
  buffer.accept(identityEvent("A100", { name: "OLD" }));
  assert.equal(drainEntries(buffer)[0].identity?.name, "OLD");

  buffer.accept(identityEvent("A100", { name: "NEW" }));
  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].identity?.name, "NEW");
  assert.equal(buffer.getStats().identityDuplicates, 0);
});

test("vân tay identity chỉ gồm imo|name|vesselTypeCode, không băm mật mã", () => {
  const base = identityEvent("A100").result.identity as VesselIdentity;
  assert.equal(identityFingerprint(base), "9074729|AGIA DOXA|70");
  // MMSI là KHOÁ của ô nhớ nên không nằm trong vân tay.
  assert.equal(
    identityFingerprint({ ...base, mmsi: "B200" }),
    identityFingerprint(base)
  );
  assert.notEqual(identityFingerprint({ ...base, vesselTypeCode: 71 }), identityFingerprint(base));
  assert.equal(identityFingerprint({ ...base, imo: null, name: null, vesselTypeCode: null }), "||");
});

// ---------------------------------------------------------------------------
//  §33 + §34 · Trần bộ nhớ và đuổi
// ---------------------------------------------------------------------------

test("§33 max=3, nạp 4 tàu -> size không bao giờ vượt 3, đúng 1 lần đuổi", () => {
  const buffer = buildBuffer(3);
  for (const mmsi of ["A", "B", "C", "D"]) {
    buffer.accept(positionEvent(mmsi, at("12:00:01")));
    assert.ok(buffer.size() <= 3, `size vượt trần ở ${mmsi}`);
  }

  const stats = buffer.getStats();
  assert.equal(buffer.size(), 3);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.maxObservedBufferedVessels, 3);
  // A bị đuổi khi CÒN dữ liệu chờ -> phải lộ ra, không giấu.
  assert.equal(stats.evictedDirty, 1);

  const entries = drainEntries(buffer);
  assert.deepEqual(entries.map((entry) => entry.mmsi).sort(), ["B", "C", "D"]);
});

test("§34 chạm vào A rồi nạp D -> B bị đuổi, KHÔNG phải A", () => {
  const buffer = buildBuffer(3);
  buffer.accept(positionEvent("A", at("12:00:01")));
  buffer.accept(positionEvent("B", at("12:00:01")));
  buffer.accept(positionEvent("C", at("12:00:01")));
  // Chạm A -> A xuống cuối hàng đợi đuổi.
  buffer.accept(positionEvent("A", at("12:00:05")));
  buffer.accept(positionEvent("D", at("12:00:01")));

  const entries = drainEntries(buffer);
  const kept = entries.map((entry) => entry.mmsi).sort();
  assert.deepEqual(kept, ["A", "C", "D"]);
  assert.equal(buffer.getStats().evictions, 1);
});

test("đuổi hàng trăm lần liên tiếp -> vẫn đúng LRU, không lệch con trỏ", () => {
  // Con trỏ đuổi được DÙNG LẠI giữa các lần (vì lý do hiệu năng, xem
  // AisCoalescingBuffer). Test này khoá phần đắt nhất của tối ưu đó: sau rất
  // nhiều vòng dựng lại/chạy hết, kẻ sống sót vẫn phải là 3 tàu mới nhất.
  const buffer = buildBuffer(3);
  for (let i = 0; i < 200; i += 1) {
    buffer.accept(positionEvent(`M${i}`, at("12:00:01")));
    assert.ok(buffer.size() <= 3, `size vượt trần ở vòng ${i}`);
  }

  const entries = drainEntries(buffer);
  assert.deepEqual(entries.map((entry) => entry.mmsi).sort(), ["M197", "M198", "M199"]);
  assert.equal(buffer.getStats().evictions, 197);
});

test("touch xen kẽ đuổi qua nhiều vòng -> tàu được touch KHÔNG bị đuổi", () => {
  const buffer = buildBuffer(3);
  buffer.accept(positionEvent("KEEP", at("12:00:00")));

  for (let i = 0; i < 100; i += 1) {
    // Giữ KEEP luôn ở cuối hàng đợi đuổi.
    buffer.accept(positionEvent("KEEP", new Date(at("12:00:00").getTime() + (i + 1) * 1000)));
    buffer.accept(positionEvent(`X${i}`, at("12:00:01")));
    assert.ok(buffer.size() <= 3);
  }

  const survivors = drainEntries(buffer).map((entry) => entry.mmsi);
  assert.ok(survivors.includes("KEEP"), `KEEP bị đuổi oan: ${survivors.join(",")}`);
});

test("đuổi entry ĐÃ SẠCH không tính là mất dữ liệu", () => {
  const buffer = buildBuffer(2);
  buffer.accept(positionEvent("A", at("12:00:01")));
  buffer.accept(positionEvent("B", at("12:00:01")));
  drainEntries(buffer); // cả hai thành sạch

  buffer.accept(positionEvent("C", at("12:00:01")));
  const stats = buffer.getStats();
  assert.equal(stats.evictions, 1);
  assert.equal(stats.evictedDirty, 0, "không có gì chờ drain nên không mất gì");
});

// ---------------------------------------------------------------------------
//  §35 + §21 · Rút theo mẻ, KHÔNG mất phần dư
// ---------------------------------------------------------------------------

test("§35 1200 tàu, mẻ 500 -> 500 + 500 + 200, không mất entry nào", () => {
  const buffer = buildBuffer(2000, 500);
  for (let i = 0; i < 1200; i += 1) {
    buffer.accept(positionEvent(`M${i}`, at("12:00:01")));
  }

  const first = buffer.drainBatch();
  const second = buffer.drainBatch();
  const third = buffer.drainBatch();
  const fourth = buffer.drainBatch();

  assert.equal(first?.entries.length, 500);
  assert.equal(second?.entries.length, 500);
  assert.equal(third?.entries.length, 200);
  assert.equal(fourth, null);

  assert.equal(first?.remaining, 700);
  assert.equal(second?.remaining, 200);
  assert.equal(third?.remaining, 0);

  const all = new Set([
    ...(first?.entries ?? []).map((entry) => entry.mmsi),
    ...(second?.entries ?? []).map((entry) => entry.mmsi),
    ...(third?.entries ?? []).map((entry) => entry.mmsi),
  ]);
  assert.equal(all.size, 1200, "không entry nào bị bỏ rơi");
  assert.equal(buffer.getStats().flushedEntries, 1200);
  assert.equal(buffer.getStats().flushes, 3);
});

test("§21 rút MỘT mẻ rồi dừng -> phần dư CÒN NGUYÊN, không bị xoá theo", () => {
  const buffer = buildBuffer(2000, 500);
  for (let i = 0; i < 1200; i += 1) buffer.accept(positionEvent(`M${i}`, at("12:00:01")));

  buffer.drainBatch(500);
  assert.equal(buffer.pendingCount(), 700);
  assert.equal(buffer.size(), 1200, "entry ở lại để giữ mốc + vân tay");
});

test("drainAll có trần số mẻ -> phần dư để lại cho chu kỳ sau", () => {
  const buffer = buildBuffer(2000, 100);
  for (let i = 0; i < 1000; i += 1) buffer.accept(positionEvent(`M${i}`, at("12:00:01")));

  const batches = buffer.drainAll(3);
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((total, batch) => total + batch.entries.length, 0), 300);
  assert.equal(buffer.pendingCount(), 700);
});

// ---------------------------------------------------------------------------
//  §22 + §24 · Không tích hàng đợi, không lịch sử
// ---------------------------------------------------------------------------

test("§22 consumer chậm KHÔNG làm hàng đợi phình — update mới đè trạng thái cũ", () => {
  const buffer = buildBuffer();
  // 1000 lần cập nhật của cùng một tàu mà chưa ai drain.
  for (let i = 0; i < 1000; i += 1) {
    buffer.accept(positionEvent("A100", new Date(at("12:00:00").getTime() + i * 1000), { lat: i }));
  }

  assert.equal(buffer.size(), 1, "một tàu vẫn là một ô");
  assert.equal(buffer.pendingCount(), 1, "không có hàng đợi mẻ nào tích lại");

  const entries = drainEntries(buffer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].position?.lat, 999, "chỉ trạng thái mới nhất sống sót");
});

test("§24 buffer KHÔNG giữ mảng lịch sử vị trí nào", () => {
  const buffer = buildBuffer();
  for (let i = 0; i < 50; i += 1) {
    buffer.accept(positionEvent("A100", new Date(at("12:00:00").getTime() + i * 1000)));
  }
  const held = Object.values(buffer as unknown as Record<string, unknown>).filter(
    (value) => Array.isArray(value) && value.length > 0
  );
  assert.deepEqual(held, []);
});

// ---------------------------------------------------------------------------
//  Biên
// ---------------------------------------------------------------------------

test("event không dùng được -> đếm rejected, không tạo ô nhớ", () => {
  const buffer = buildBuffer();
  buffer.accept({ result: {}, mmsi: "A100" });
  buffer.accept({ ...positionEvent("A100", at("12:00:01")), mmsi: "" });

  assert.equal(buffer.size(), 0);
  assert.equal(buffer.getStats().rejectedEvents, 2);
  assert.equal(buffer.getStats().acceptedEvents, 0);
});

test("buffer rỗng -> drainBatch trả null, không ném", () => {
  const buffer = buildBuffer();
  assert.equal(buffer.drainBatch(), null);
  assert.deepEqual(buffer.drainAll(), []);
});

test("cấu hình vô lý -> ném NGAY lúc dựng", () => {
  assert.throws(() => new AisCoalescingBuffer({ maxVessels: 0, batchSize: 10 }), /maxVessels/);
  assert.throws(() => new AisCoalescingBuffer({ maxVessels: 10, batchSize: 0 }), /batchSize/);
  assert.throws(() => new AisCoalescingBuffer({ maxVessels: 1.5, batchSize: 10 }), /maxVessels/);
});

test("createdAt của mẻ lấy từ đồng hồ tiêm vào", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:00:01")));
  assert.equal(buffer.drainBatch()?.createdAt.toISOString(), CREATED_AT.toISOString());
});

test("clear() xoá trạng thái nhưng GIỮ bộ đếm vận hành", () => {
  const buffer = buildBuffer();
  buffer.accept(positionEvent("A100", at("12:00:01")));
  buffer.clear();

  assert.equal(buffer.size(), 0);
  assert.equal(buffer.pendingCount(), 0);
  assert.equal(buffer.getStats().positionEvents, 1);
});
