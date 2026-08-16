// ============================================================================
//  TEST · GetCanonicalVesselDetail + VesselDetailProjector
// ----------------------------------------------------------------------------
//  Kho là bản giả trong bộ nhớ. Không Mongo, không mạng, không crawler.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CurrentVesselSaveResult,
  ICurrentVesselRepository,
} from "../../contracts/repositories/ICurrentVesselRepository";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { createSourceMetadata } from "../../../domain/value-objects/SourceMetadata";
import { VesselPositionReport } from "../../../domain/value-objects/VesselPositionReport";
import { PositionFreshness } from "../../services/resolution/PositionResolverPolicy";
import { ResolvedCurrentVessel } from "../../services/resolution/ResolvedCurrentVessel";
import {
  DetailGroup,
  DetailGroupStatus,
  projectVesselDetail,
} from "../../services/vessel/VesselDetailProjector";
import {
  GetCanonicalVesselDetail,
  InvalidVesselIdentifierError,
  VesselDetailStatus,
} from "./GetCanonicalVesselDetail";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const MMSI = "636018086";
const IMO = "9074729";

function field<T>(value: T, fetchedAt: Date = NOW) {
  return {
    value,
    source: VesselSource.SHIPINFO,
    observationId: "obs-should-not-leak",
    observedAt: null,
    fetchedAt,
    reason: "ONLY_AVAILABLE_VALUE",
    rejected: [{ source: VesselSource.SHIPFINDER, reason: "LOWER_FIELD_QUALITY" }],
  } as never;
}

interface Options {
  mmsi?: string | null;
  imo?: string;
  position?: { lat?: number; lon?: number; observedAt?: Date | null } | null;
  identity?: boolean;
  particulars?: boolean;
  voyage?: boolean;
  staticFetchedAt?: Date;
  storedFreshness?: PositionFreshness;
}

function vessel(options: Options = {}): ResolvedCurrentVessel {
  const staticAt = options.staticFetchedAt ?? NOW;
  const positionOptions = options.position === undefined ? {} : options.position;

  let position: ResolvedCurrentVessel["position"] = null;
  if (positionOptions !== null) {
    const observedAt =
      positionOptions.observedAt === undefined
        ? new Date(NOW.getTime() - 60_000)
        : positionOptions.observedAt;
    const report: VesselPositionReport = {
      mmsi: MMSI,
      imo: null,
      lat: positionOptions.lat ?? 10,
      lng: positionOptions.lon ?? 106,
      speed: 12.3,
      course: 87,
      heading: null,
      navStatus: { code: 0, text: "Under way using engine" },
      latLngApproximate: false,
      receivedAt: observedAt ?? NOW,
      metadata: createSourceMetadata({
        source: VesselSource.AISSTREAM,
        fetchedAt: NOW,
        sourceReceivedAt: observedAt,
      }),
    };
    position = {
      position: report,
      source: VesselSource.AISSTREAM,
      observationId: "obs-should-not-leak",
      observedAt,
      fetchedAt: NOW,
      freshness: options.storedFreshness ?? PositionFreshness.LIVE,
      reason: "ONLY_AVAILABLE_VALUE",
      rejected: [{ source: VesselSource.SHIPFINDER, reason: "STALER_TIMESTAMP" }],
    } as never;
  }

  return {
    vesselKey: {
      mmsi: options.mmsi === null ? undefined : options.mmsi ?? MMSI,
      imo: options.imo,
    },
    position,
    identity:
      options.identity === false
        ? null
        : ({
            mmsi: MMSI,
            imo: field(IMO, staticAt),
            name: field("AGIA DOXA", staticAt),
            callsign: field("5LAB9", staticAt),
            vesselType: field("Bulk Carrier", staticAt),
            vesselTypeCode: field(70, staticAt),
            flagCode: field("LR", staticAt),
            flagName: field("Liberia", staticAt),
          } as never),
    particulars:
      options.particulars === false
        ? null
        : ({
            mmsi: MMSI,
            length: field(179, staticAt),
            beam: field(29, staticAt),
            draught: field(5.9, staticAt),
            grossTonnage: null,
            deadweight: field(33261, staticAt),
            builtYear: field(2010, staticAt),
          } as never),
    voyage:
      options.voyage === false
        ? null
        : ({
            mmsi: MMSI,
            destination: field("LONG BEACH, US", staticAt),
            eta: null,
            currentPort: null,
            nextPort: null,
            lastPort: null,
            lastPortDepartureAt: null,
          } as never),
    resolvedAt: NOW,
  };
}

class FakeRepository implements ICurrentVesselRepository {
  byMmsi = new Map<string, ResolvedCurrentVessel>();
  byImo = new Map<string, ResolvedCurrentVessel>();
  calls: string[] = [];

  async upsert(): Promise<CurrentVesselSaveResult> {
    throw new Error("DETAIL-1 không được ghi gì");
  }
  async findByMmsi(mmsi: string): Promise<ResolvedCurrentVessel | null> {
    this.calls.push(`mmsi:${mmsi}`);
    return this.byMmsi.get(mmsi) ?? null;
  }
  async findByImo(imo: string): Promise<ResolvedCurrentVessel | null> {
    this.calls.push(`imo:${imo}`);
    return this.byImo.get(imo) ?? null;
  }
}

function useCase(seed: ResolvedCurrentVessel | null = vessel()) {
  const repository = new FakeRepository();
  if (seed !== null) {
    if (seed.vesselKey.mmsi !== undefined) repository.byMmsi.set(seed.vesselKey.mmsi, seed);
    if (seed.vesselKey.imo !== undefined) repository.byImo.set(seed.vesselKey.imo, seed);
  }
  return {
    repository,
    sut: new GetCanonicalVesselDetail({ repository, now: () => NOW }),
  };
}

// ---------------------------------------------------------------------------
//  §27 · Đủ bốn nhóm
// ---------------------------------------------------------------------------

test("§27 canonical đủ bốn nhóm -> chiếu đúng hết", async () => {
  const { sut } = useCase();
  const result = await sut.execute({ mmsi: MMSI });

  assert.equal(result.status, VesselDetailStatus.FOUND);
  const detail = result.detail!;

  assert.equal(detail.identifiers.mmsi, MMSI);
  assert.equal(detail.identifiers.imo, IMO);
  assert.equal(detail.identity.name?.value, "AGIA DOXA");
  assert.equal(detail.identity.flagName?.value, "Liberia");
  assert.equal(detail.position?.lat, 10);
  assert.equal(detail.position?.lon, 106, "read model dùng `lon`, canonical dùng `lng`");
  assert.equal(detail.position?.navStatusText, "Under way using engine");
  assert.equal(detail.particulars.length?.value, 179);
  assert.equal(detail.voyage.destination?.value, "LONG BEACH, US");

  for (const group of Object.values(DetailGroup)) {
    assert.equal(detail.groups[group].status, DetailGroupStatus.AVAILABLE, group);
  }
  assert.deepEqual(detail.missingGroups, []);
  assert.deepEqual(detail.staleGroups, []);
  assert.equal(detail.needsRefresh, false);
});

// ---------------------------------------------------------------------------
//  §28 + §14 + §15 · Chi tiết TỪNG PHẦN vẫn hợp lệ
// ---------------------------------------------------------------------------

test("§28 chỉ MMSI + vị trí -> FOUND, không phải 404", async () => {
  const partial = vessel({ identity: false, particulars: false, voyage: false });
  const { sut } = useCase(partial);
  const result = await sut.execute({ mmsi: MMSI });

  assert.equal(result.status, VesselDetailStatus.FOUND);
  const detail = result.detail!;

  assert.equal(detail.position?.lat, 10);
  assert.equal(detail.groups[DetailGroup.POSITION].status, DetailGroupStatus.AVAILABLE);
  assert.deepEqual([...detail.missingGroups].sort(), ["IDENTITY", "PARTICULARS", "VOYAGE"]);
  // §13: DETAIL-2 biết phải làm gì, nhưng DETAIL-1 KHÔNG kích hoạt gì cả.
  assert.equal(detail.needsRefresh, true);
  assert.deepEqual([...detail.refreshGroups].sort(), ["IDENTITY", "PARTICULARS", "VOYAGE"]);
});

test("§14 particulars thiếu KHÔNG làm hỏng vị trí vừa tươi từ AIS", async () => {
  const detail = projectVesselDetail(vessel({ particulars: false }), NOW);
  assert.equal(detail.groups[DetailGroup.POSITION].status, DetailGroupStatus.AVAILABLE);
  assert.equal(detail.groups[DetailGroup.PARTICULARS].status, DetailGroupStatus.MISSING);
});

// ---------------------------------------------------------------------------
//  §29 → §32 · Độ tươi vị trí TÍNH LẠI
// ---------------------------------------------------------------------------

test("§30 mốc mới -> AVAILABLE, có ageMs", async () => {
  const detail = projectVesselDetail(vessel(), NOW);
  assert.equal(detail.position?.status, DetailGroupStatus.AVAILABLE);
  assert.equal(detail.position?.ageMs, 60_000);
});

test("§29 freshness ĐÃ LƯU nói LIVE nhưng mốc 3 ngày -> STALE", async () => {
  const trap = vessel({
    position: { observedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000) },
    storedFreshness: PositionFreshness.LIVE,
  });
  assert.equal(trap.position?.freshness, PositionFreshness.LIVE, "document vẫn nói LIVE");

  const detail = projectVesselDetail(trap, NOW);
  assert.equal(detail.position?.status, DetailGroupStatus.STALE);
  assert.deepEqual(detail.staleGroups, [DetailGroup.POSITION]);
  assert.equal(detail.needsRefresh, true);
});

test("§31 nguồn không khai mốc -> ageMs null, KHÔNG bịa `now`", async () => {
  const detail = projectVesselDetail(vessel({ position: { observedAt: null } }), NOW);
  assert.equal(detail.position?.observedAt, null);
  assert.equal(detail.position?.ageMs, null);
  assert.equal(detail.position?.status, DetailGroupStatus.STALE, "không biết tuổi ≠ tươi");
});

test("§32 mốc ở TƯƠNG LAI xa -> không được coi là tươi", async () => {
  const detail = projectVesselDetail(
    vessel({ position: { observedAt: new Date(NOW.getTime() + 60 * 60 * 1000) } }),
    NOW
  );
  assert.equal(detail.position?.status, DetailGroupStatus.STALE);
});

test("lệch đồng hồ nhỏ vẫn AVAILABLE", async () => {
  const detail = projectVesselDetail(
    vessel({ position: { observedAt: new Date(NOW.getTime() + 60_000) } }),
    NOW
  );
  assert.equal(detail.position?.status, DetailGroupStatus.AVAILABLE);
});

test("toạ độ hỏng -> position null, nhóm MISSING", async () => {
  const detail = projectVesselDetail(vessel({ position: { lat: 91 } }), NOW);
  assert.equal(detail.position, null);
  assert.equal(detail.groups[DetailGroup.POSITION].status, DetailGroupStatus.MISSING);
});

// ---------------------------------------------------------------------------
//  §8 + §10 · Độ tươi TÁCH THEO NHÓM
// ---------------------------------------------------------------------------

test("§8 mỗi nhóm có tuổi riêng — voyage cũ không kéo theo identity", async () => {
  // Nhóm tĩnh lấy 10 ngày trước: quá ngưỡng voyage (7 ngày) nhưng vẫn trong
  // ngưỡng identity/particulars (90 ngày).
  const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
  const detail = projectVesselDetail(vessel({ staticFetchedAt: tenDaysAgo }), NOW);

  assert.equal(detail.groups[DetailGroup.IDENTITY].status, DetailGroupStatus.AVAILABLE);
  assert.equal(detail.groups[DetailGroup.PARTICULARS].status, DetailGroupStatus.AVAILABLE);
  assert.equal(detail.groups[DetailGroup.VOYAGE].status, DetailGroupStatus.STALE);
  assert.equal(detail.groups[DetailGroup.POSITION].status, DetailGroupStatus.AVAILABLE);

  assert.deepEqual(detail.staleGroups, [DetailGroup.VOYAGE]);
  assert.deepEqual(detail.refreshGroups, [DetailGroup.VOYAGE]);
  assert.equal(detail.groups[DetailGroup.IDENTITY].ageMs, 10 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
//  §35 · KHÔNG rò nội bộ resolver
// ---------------------------------------------------------------------------

test("§35 output KHÔNG chứa rejected / observationId / reason / contentHash", async () => {
  const { sut } = useCase();
  const result = await sut.execute({ mmsi: MMSI });
  const serialized = JSON.stringify(result.detail);

  for (const internal of ["rejected", "observationId", "reason", "contentHash", "freshness"]) {
    assert.equal(serialized.includes(internal), false, `rò \`${internal}\` ra read model`);
  }
  assert.equal(serialized.includes("obs-should-not-leak"), false);
});

test("§7 xuất xứ NHẸ vẫn có: value + source + hai mốc", async () => {
  const detail = projectVesselDetail(vessel(), NOW);
  assert.deepEqual(Object.keys(detail.identity.name!).sort(), [
    "fetchedAt",
    "observedAt",
    "source",
    "value",
  ]);
  assert.equal(detail.identity.name?.source, VesselSource.SHIPINFO);
  assert.equal(detail.position?.source, VesselSource.AISSTREAM);
});

// ---------------------------------------------------------------------------
//  §33 + §4 · Định danh
// ---------------------------------------------------------------------------

test("§33 tra được bằng MMSI và bằng IMO", async () => {
  const { sut } = useCase(vessel({ imo: IMO }));
  assert.equal((await sut.execute({ mmsi: MMSI })).status, VesselDetailStatus.FOUND);
  assert.equal((await sut.execute({ imo: IMO })).status, VesselDetailStatus.FOUND);
});

test("§17 MMSI lấy thẳng từ MapVesselItem là dùng được ngay", async () => {
  const { sut, repository } = useCase();
  await sut.execute({ mmsi: MMSI });
  assert.deepEqual(repository.calls, [`mmsi:${MMSI}`], "không cần bước tra IMO trung gian");
});

test("§4 định danh sai -> NÉM TRƯỚC khi chạm kho", async () => {
  const { sut, repository } = useCase();
  for (const input of [
    {},
    { mmsi: "" },
    { mmsi: "12345" },
    { mmsi: "abcdefghi" },
    { imo: "9074728" }, // sai chữ số kiểm tra
    { imo: "123" },
  ]) {
    await assert.rejects(() => sut.execute(input), InvalidVesselIdentifierError, JSON.stringify(input));
  }
  assert.deepEqual(repository.calls, [], "kho không được gọi với định danh rác");
});

// ---------------------------------------------------------------------------
//  §16 · Không thấy thì nói không thấy
// ---------------------------------------------------------------------------

test("§16 canonical chưa biết -> NOT_FOUND, KHÔNG tự đi crawl", async () => {
  const { sut, repository } = useCase(null);
  const result = await sut.execute({ mmsi: MMSI, imo: IMO });

  assert.equal(result.status, VesselDetailStatus.NOT_FOUND);
  assert.equal(result.detail, null);
  // Chỉ đọc canonical, hai lượt tra, không nguồn ngoài nào được gọi.
  assert.deepEqual(repository.calls, [`mmsi:${MMSI}`, `imo:${IMO}`]);
});

// ---------------------------------------------------------------------------
//  §22 + §34 · Không bịa giá trị mặc định
// ---------------------------------------------------------------------------

test("§34 thiếu thì null — KHÔNG 'N/A', KHÔNG 0", async () => {
  const detail = projectVesselDetail(
    vessel({ mmsi: null, imo: undefined, identity: false, particulars: false, voyage: false }),
    NOW
  );

  assert.equal(detail.identifiers.mmsi, null);
  assert.equal(detail.identifiers.imo, null);
  assert.equal(detail.identity.name, null);
  assert.equal(detail.particulars.grossTonnage, null);
  assert.equal(detail.voyage.destination, null);

  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('"N/A"'), false);
  assert.equal(serialized.includes('"Unknown"'), false);
});

test("§23 mốc thời gian giữ kiểu Date, không stringify sớm", async () => {
  const detail = projectVesselDetail(vessel(), NOW);
  assert.ok(detail.resolvedAt instanceof Date);
  assert.ok(detail.position?.observedAt instanceof Date);
  assert.ok(detail.identity.name?.fetchedAt instanceof Date);
});

// ---------------------------------------------------------------------------
//  §26 · Kích thước
// ---------------------------------------------------------------------------

test("§26 detail đầy đủ ~2,1 KiB — xuất xứ từng field là phần lớn chi phí", async () => {
  const detail = projectVesselDetail(vessel(), NOW);
  const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8");

  // Đo được 2.163 B cho một tàu ĐỦ cả bốn nhóm. Phần lớn là `source` + hai mốc
  // ISO nhân 13 field (~90 B/field) — cái giá của việc biết ai nói và nói lúc
  // nào. Chấp nhận được vì detail là MỘT tàu mỗi lần hỏi, không phải mười nghìn
  // chấm như map.
  //
  // ⚠️ Đây là lưới chống PHÌNH, không phải mục tiêu tối ưu. Hàng rào chống rò
  // nội bộ resolver là test §35 (kiểm cấu trúc); test này chỉ bắt trường hợp ai
  // đó nhét cả mảng `rejected` vào và làm payload tăng vọt.
  assert.ok(bytes < 3072, `detail ${bytes} B — kiểm lại xem có rò nội bộ resolver không`);
  assert.ok(bytes > 1024, `detail ${bytes} B — nhỏ bất thường, có mất field không?`);
});
