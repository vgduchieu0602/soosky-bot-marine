// ============================================================================
//  TEST · VoyageResolver
// ----------------------------------------------------------------------------
//  Số liệu lấy từ `vessel_observations` sau POC P7.4 (chỉ ShipFinder có voyage).
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselVoyage } from "../../domain/canonical/VesselVoyage";
import { ObservationValidationStatus } from "../../domain/observations/ObservationValidation";
import {
  VesselObservationType,
  VesselSourceObservation,
  VoyageObservation,
} from "../../domain/observations/VesselObservation";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { RejectionReason, ResolutionReason } from "./ResolverTypes";
import { VoyageResolver } from "./VoyageResolver";

const MMSI = "636018086";
const SHIPFINDER_AT = new Date("2026-08-14T16:40:41.985Z");
const OLDER_AT = new Date("2026-08-14T10:40:13.307Z");

function voyage(props: {
  source: VesselSource;
  fetchedAt: Date;
  id?: string;
  invalid?: boolean;
  data?: Partial<VesselVoyage>;
}): VoyageObservation {
  const data: VesselVoyage = {
    mmsi: MMSI,
    metadata: createSourceMetadata({ source: props.source, fetchedAt: props.fetchedAt }),
    ...props.data,
  };
  return {
    id: props.id ?? `obs-${props.source}`,
    source: props.source,
    type: VesselObservationType.VOYAGE,
    vesselKey: { mmsi: MMSI },
    fetchedAt: props.fetchedAt,
    sourceReceivedAt: null,
    validation: {
      status: props.invalid
        ? ObservationValidationStatus.INVALID
        : ObservationValidationStatus.VALID,
      errors: [],
    },
    data,
  };
}

const resolver = new VoyageResolver();

// ---- CA THẬT · ShipFinder ------------------------------------------------

test("CA THẬT · chỉ ShipFinder có voyage -> destination có, eta null", () => {
  const result = resolver.resolve([
    voyage({
      source: VesselSource.SHIPFINDER,
      id: "6a7f450a521d474c8df814ec",
      fetchedAt: SHIPFINDER_AT,
      data: { destination: "LONG BEACH, US", eta: null },
    }),
  ]);

  assert.ok(result);
  assert.equal(result.destination?.value, "LONG BEACH, US");
  assert.equal(result.destination?.source, VesselSource.SHIPFINDER);
  assert.equal(result.destination?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.equal(result.destination?.observationId, "6a7f450a521d474c8df814ec");

  // Nguồn cho "07-29 07:01" (thiếu năm) -> mapper P7 cố ý không map.
  assert.equal(result.eta, null);
  assert.equal(result.currentPort, null);
  assert.equal(result.nextPort, null);
  assert.equal(result.lastPort, null);
});

// ---- Destination ----------------------------------------------------------

test("khác cách viết KHÔNG phải xung đột", () => {
  const a = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: "LONG BEACH, US" },
  });
  const b = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "Long Beach,  US" },
  });

  const result = resolver.resolve([a, b]);
  assert.equal(result?.destination?.reason, ResolutionReason.SOURCES_AGREE);
  // Giữ nguyên dạng của nguồn thắng, không viết lại chuỗi.
  assert.equal(result?.destination?.value, "LONG BEACH, US");
});

test("đổi cảng đích -> bản MỚI HƠN thắng", () => {
  const older = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "SINGAPORE" },
  });
  const newer = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: "LONG BEACH, US" },
  });

  const result = resolver.resolve([older, newer]);

  assert.equal(result?.destination?.value, "LONG BEACH, US");
  assert.equal(result?.destination?.reason, ResolutionReason.NEWER_FETCH);
  assert.deepEqual(
    result?.destination?.rejected.map((r) => [r.source, r.reason]),
    [[VesselSource.SHIPINFO, RejectionReason.OLDER_FETCH]]
  );
});

test("độ mới đứng TRƯỚC hạng capability — khác Identity/Particulars", () => {
  // ShipInfo có defaultPriority tốt hơn (45 vs 55) nhưng nói về chuyến CŨ.
  const shipinfoOlder = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "SINGAPORE" },
  });
  const shipfinderNewer = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: "VERACRUZ, MX" },
  });

  const result = resolver.resolve([shipinfoOlder, shipfinderNewer]);
  assert.equal(result?.destination?.value, "VERACRUZ, MX");
  assert.equal(result?.destination?.reason, ResolutionReason.NEWER_FETCH);
});

test("null từ nguồn mới hơn KHÔNG xoá destination của nguồn cũ", () => {
  const newerNull = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: null },
  });
  const olderValue = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "VERACRUZ, MX" },
  });

  const result = resolver.resolve([newerNull, olderValue]);
  assert.equal(result?.destination?.value, "VERACRUZ, MX");
  assert.equal(result?.destination?.source, VesselSource.SHIPINFO);
  assert.equal(result?.destination?.reason, ResolutionReason.ONLY_AVAILABLE_VALUE);
  assert.deepEqual([...(result?.destination?.rejected ?? [])], []);
});

test("chuỗi rỗng/trắng không phải ứng viên", () => {
  const blank = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: "   " },
  });
  const real = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "SINGAPORE" },
  });
  assert.equal(resolver.resolve([blank, real])?.destination?.value, "SINGAPORE");
});

// ---- ETA ------------------------------------------------------------------

test("ETA: chỉ nhận Date canonical hợp lệ; mới hơn thắng", () => {
  const older = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { eta: new Date("2026-08-20T07:00:00.000Z") },
  });
  const newer = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { eta: new Date("2026-08-22T09:30:00.000Z") },
  });

  const result = resolver.resolve([older, newer]);
  assert.equal(result?.eta?.value.toISOString(), "2026-08-22T09:30:00.000Z");
  assert.equal(result?.eta?.reason, ResolutionReason.NEWER_FETCH);
});

test("ETA null từ nguồn mới hơn không xoá Date hợp lệ của nguồn cũ", () => {
  const newerNull = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { eta: null },
  });
  const olderDate = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { eta: new Date("2026-08-20T07:00:00.000Z") },
  });

  const result = resolver.resolve([newerNull, olderDate]);
  assert.equal(result?.eta?.value.toISOString(), "2026-08-20T07:00:00.000Z");
  assert.equal(result?.eta?.source, VesselSource.SHIPINFO);
});

test("ETA hai nguồn CÙNG mốc -> SOURCES_AGREE (Date so theo GIÁ TRỊ)", () => {
  const at = "2026-08-20T07:00:00.000Z";
  const a = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { eta: new Date(at) },
  });
  const b = voyage({ source: VesselSource.SHIPINFO, fetchedAt: OLDER_AT, data: { eta: new Date(at) } });

  // Hai object Date khác nhau nhưng cùng thời điểm -> KHÔNG phải xung đột.
  assert.equal(resolver.resolve([a, b])?.eta?.reason, ResolutionReason.SOURCES_AGREE);
});

test("ETA là Invalid Date -> không phải ứng viên", () => {
  const bad = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { eta: new Date("không phải ngày") },
  });
  assert.equal(resolver.resolve([bad])?.eta, null);
});

// ---- Cảng -----------------------------------------------------------------

test("cảng: KHÔNG suy currentPort từ destination", () => {
  const result = resolver.resolve([
    voyage({
      source: VesselSource.SHIPFINDER,
      fetchedAt: SHIPFINDER_AT,
      data: { destination: "LONG BEACH, US" },
    }),
  ]);

  assert.equal(result?.destination?.value, "LONG BEACH, US");
  assert.equal(result?.currentPort, null, "destination KHÁC currentPort");
  assert.equal(result?.lastPort, null);
  assert.equal(result?.lastPortDepartureAt, null);
});

test("cảng có dữ liệu thật -> resolve theo field, mới hơn thắng", () => {
  const older = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { currentPort: "SINGAPORE", lastPort: "BUSAN" },
  });
  const newer = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { currentPort: "LONG BEACH", lastPort: null },
  });

  const result = resolver.resolve([older, newer]);
  assert.equal(result?.currentPort?.value, "LONG BEACH");
  assert.equal(result?.currentPort?.reason, ResolutionReason.NEWER_FETCH);
  // `lastPort` chỉ nguồn cũ có -> vẫn giữ, trộn theo FIELD.
  assert.equal(result?.lastPort?.value, "BUSAN");
  assert.equal(result?.lastPort?.source, VesselSource.SHIPINFO);
});

test("lastPortDepartureAt: Date canonical, không suy từ fetchedAt", () => {
  const departure = new Date("2026-08-10T03:15:00.000Z");
  const result = resolver.resolve([
    voyage({
      source: VesselSource.SHIPFINDER,
      fetchedAt: SHIPFINDER_AT,
      data: { lastPortDepartureAt: departure },
    }),
  ]);

  assert.equal(result?.lastPortDepartureAt?.value.getTime(), departure.getTime());
  assert.notEqual(result?.lastPortDepartureAt?.value.getTime(), SHIPFINDER_AT.getTime());
});

// ---- INVALID / rỗng -------------------------------------------------------

test("INVALID mới hơn không thắng VALID cũ hơn", () => {
  const invalidNewer = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    invalid: true,
    data: { destination: "SAI" },
  });
  const valid = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "SINGAPORE" },
  });

  const result = resolver.resolve([invalidNewer, valid]);
  assert.equal(result?.destination?.value, "SINGAPORE");
});

test("không có observation VOYAGE -> null", () => {
  assert.equal(resolver.resolve([]), null);
  const other = {
    ...voyage({ source: VesselSource.SHIPFINDER, fetchedAt: SHIPFINDER_AT }),
    type: VesselObservationType.IDENTITY,
  } as unknown as VesselSourceObservation;
  assert.equal(resolver.resolve([other]), null);
});

// ---- Tất định -------------------------------------------------------------

test("TẤT ĐỊNH: đảo thứ tự đầu vào không đổi kết quả", () => {
  const a = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: SHIPFINDER_AT,
    data: { destination: "LONG BEACH, US" },
  });
  const b = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: OLDER_AT,
    data: { destination: "SINGAPORE" },
  });
  const c = voyage({
    source: VesselSource.VESSELFINDER,
    fetchedAt: OLDER_AT,
    data: { destination: "BUSAN" },
  });

  const winners = [
    [a, b, c], [c, b, a], [b, a, c], [a, c, b], [c, a, b],
  ].map((input) => resolver.resolve(input)?.destination?.value);

  assert.equal(new Set(winners).size, 1, `winner phải ổn định, nhận ${winners.join(" | ")}`);
  assert.equal(winners[0], "LONG BEACH, US");
});

test("cùng fetchedAt -> hạng capability phân định (tiêu chí thứ hai)", () => {
  const at = SHIPFINDER_AT;
  // Matrix: destination CONFIRMED cho shipfinder, UNSUPPORTED cho shipinfo.
  const shipfinder = voyage({
    source: VesselSource.SHIPFINDER,
    fetchedAt: at,
    data: { destination: "A" },
  });
  const shipinfo = voyage({
    source: VesselSource.SHIPINFO,
    fetchedAt: at,
    data: { destination: "B" },
  });

  const result = resolver.resolve([shipfinder, shipinfo]);
  // ShipInfo có priority TỐT HƠN (45 vs 55) nhưng thua vì capability thấp hơn.
  assert.equal(result?.destination?.source, VesselSource.SHIPFINDER);
  assert.equal(result?.destination?.reason, ResolutionReason.HIGHER_FIELD_QUALITY);
  assert.deepEqual(
    result?.destination?.rejected.map((r) => r.reason),
    [RejectionReason.LOWER_FIELD_QUALITY]
  );
  assert.equal(resolver.resolve([shipinfo, shipfinder])?.destination?.source, VesselSource.SHIPFINDER);
});

test("TẤT ĐỊNH: hoà cả fetchedAt lẫn capability -> priority quyết định", () => {
  const at = SHIPFINDER_AT;
  // Cần HAI nguồn CÙNG mức capability cho `destination` thì tie-break mới tới
  // lượt priority. Sau AIS-1, `destination` của aisstream là CANDIDATE (Marine
  // API không chuyển tiếp field đó) — ngang với vesselfinder, mapper của nó
  // cũng chưa bóc destination.
  const aisstream = voyage({
    source: VesselSource.AISSTREAM,
    fetchedAt: at,
    data: { destination: "A" },
  });
  const vesselfinder = voyage({
    source: VesselSource.VESSELFINDER,
    fetchedAt: at,
    data: { destination: "B" },
  });

  const result = resolver.resolve([vesselfinder, aisstream]);
  // AISStream priority 10 < VesselFinder 20.
  assert.equal(result?.destination?.source, VesselSource.AISSTREAM);
  assert.equal(result?.destination?.reason, ResolutionReason.TIE_BREAK_PRIORITY);
  assert.equal(
    resolver.resolve([aisstream, vesselfinder])?.destination?.source,
    VesselSource.AISSTREAM
  );
});
