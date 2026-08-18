// ============================================================================
//  TEST · VesselFinder motion đi HẾT đường ống, không rụng field ở khúc nào
// ----------------------------------------------------------------------------
//      HTML thật của trang chi tiết
//        -> VesselFinderHtmlMapper   (parser production)
//        -> VesselFinderProvider     (canonical + mốc nguồn suy từ lrpd)
//        -> providerResultToObservation
//        -> ObservationRecorder      (validate + dedupe)
//        -> ResolveCurrentVessel     (chọn ứng viên)
//        -> ResolvedPosition         (thứ sẽ được ghi xuống canonical Mongo)
//
//  Không mạng, không Mongo: repository in-memory là CÙNG một implementation của
//  cùng một port mà production dùng, nên chuỗi mắt xích được kiểm là chuỗi thật.
//  Đồng hồ cố định ở mọi bước -> mốc thời gian kiểm được từng mili giây.
//
//  Đây là lưới chặn cho đúng lỗi mà PHASE 3 phải sửa: motion đo được ở bản chẩn
//  đoán nhưng KHÔNG tới được canonical.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { ObservationRecorder } from "../../../application/services/observation/ObservationRecorder";
import { ResolveCurrentVessel } from "../../../application/use-cases/resolution/ResolveCurrentVessel";
import { IVesselDetailsSource } from "../../../application/contracts/providers/IVesselDetailsSource";
import { IAreaScanner, ScannedShip } from "../../../application/contracts/geo/IAreaScanner";
import { InMemoryVesselObservationRepository } from "../../persistence/memory/InMemoryVesselObservationRepository";
import { ObservationValidationStatus } from "../../../domain/enums/ObservationValidation";
import { VesselObservationType } from "../../../domain/entities/VesselObservation";
import { mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { PositionFreshness } from "../../../application/services/resolution/PositionResolverPolicy";
import { VesselFinderHtmlMapper } from "./VesselFinderHtmlMapper";
import { VesselFinderProvider } from "./VesselFinderProvider";

const MMSI = "232007487";
const FETCHED_AT = new Date("2026-08-18T12:00:00.000Z");

/** Trang chi tiết rút gọn về đúng những neo mà mapper production đọc. */
function detailHtml(options: {
  sog?: number;
  cog?: number;
  lrpd?: string | null;
  navStatus?: string;
}): string {
  const djson: Record<string, unknown> = {
    mmsi: Number(MMSI),
    imo: 9074729,
    ship_lat: 51,
    ship_lon: 1,
  };
  if (options.sog !== undefined) djson.ship_sog = options.sog;
  if (options.cog !== undefined) djson.ship_cog = options.cog;
  if (options.lrpd != null) djson.lrpd = options.lrpd;

  const rows: Record<string, string> = {
    "IMO / MMSI": `9074729 / ${MMSI}`,
    "AIS Type": "Container Ship",
  };
  if (options.navStatus !== undefined) rows["Navigation Status"] = options.navStatus;

  return (
    `<h1 class="title">PIPELINE TEST</h1>` +
    `<div id="djson" data-json='${JSON.stringify(djson)}'></div>` +
    `<table>` +
    Object.entries(rows)
      .map(([k, v]) => `<td class="n3">${k}</td><td class="v3">${v}</td>`)
      .join("") +
    `</table>`
  );
}

function providerOver(
  html: string,
  ships: ScannedShip[] = [],
  now: () => Date = () => FETCHED_AT
): VesselFinderProvider {
  const detailsSource: IVesselDetailsSource = {
    async getDetails() {
      return VesselFinderHtmlMapper.toDomain(html);
    },
  };
  const areaScanner: IAreaScanner = {
    async fetchArea() {
      return ships;
    },
  };
  return new VesselFinderProvider({ detailsSource, areaScanner, now });
}

const BOX = { minLat: 50, minLon: 0, maxLat: 52, maxLon: 2 };

/**
 * Chạy trọn đường ống, trả về đúng thứ resolver chọn để ghi canonical.
 * `mapAfterDetail` mô phỏng THỨ TỰ crawl: chu kỳ discovery kế tiếp chạy SAU lần
 * tra chi tiết. Đồng hồ nhích 1 giờ giữa hai bước để "mới nhất" không mơ hồ.
 */
async function runPipeline(
  html: string,
  ships: ScannedShip[] = [],
  mapAfterDetail = false
) {
  let clock = FETCHED_AT;
  const repository = new InMemoryVesselObservationRepository({ now: () => clock });
  const recorder = new ObservationRecorder({
    repository,
    parserVersion: "vesselfinder-html-v1",
    now: () => clock,
  });
  const provider = providerOver(html, ships, () => clock);
  const scan = async () => recorder.recordPositions(await provider.scanArea(BOX));

  // Thứ tự thật của Stage A: discovery trước, rồi mới tra chi tiết — hai bước
  // cách nhau hàng phút, nên đồng hồ phải nhích (fetchedAt bằng nhau sẽ biến
  // "mới nhất" thành trò may rủi).
  if (ships.length > 0 && !mapAfterDetail) {
    await scan();
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
  }

  const details = await provider.getDetails(mmsiIdentifier(MMSI));
  assert.ok(details, "provider phải trả về chi tiết");
  const saved = await recorder.recordDetails(details);

  if (ships.length > 0 && mapAfterDetail) {
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await scan();
  }

  const resolved = await new ResolveCurrentVessel({
    repository,
    now: () => clock,
  }).execute({ mmsi: MMSI });
  assert.ok(resolved, "resolver phải dựng được canonical cho tàu này");

  const observations = await repository.findRecentByVessel(
    { mmsi: MMSI },
    { type: VesselObservationType.POSITION, includeInvalid: true }
  );

  return { details, saved, observations, resolved };
}

test("tàu đang chạy: speed/course/navStatus/observedAt tới được canonical nguyên vẹn", async () => {
  const { details, observations, resolved } = await runPipeline(
    detailHtml({ sog: 7.6, cog: 229.6, lrpd: "5 min ago", navStatus: "Under way using engine" })
  );

  // --- provider ---
  assert.equal(details.position?.speed, 7.6);
  assert.equal(details.position?.course, 229.6);
  assert.equal(details.position?.navStatus?.code, 0);
  assert.equal(
    details.position?.metadata.sourceReceivedAt?.toISOString(),
    "2026-08-18T11:55:00.000Z"
  );

  // --- observation ---
  const observation = observations.find((o) => o.type === VesselObservationType.POSITION);
  assert.ok(observation);
  assert.notEqual(observation.validation.status, ObservationValidationStatus.INVALID);
  assert.equal(observation.sourceReceivedAt?.toISOString(), "2026-08-18T11:55:00.000Z");

  // --- resolver -> canonical ---
  const position = resolved.position;
  assert.ok(position, "resolver phải chọn được vị trí");
  assert.equal(position.source, VesselSource.VESSELFINDER);
  assert.equal(position.position.speed, 7.6);
  assert.equal(position.position.course, 229.6);
  assert.equal(position.position.navStatus?.code, 0);
  assert.equal(position.observedAt?.toISOString(), "2026-08-18T11:55:00.000Z");
  // Có mốc nguồn -> KHÔNG còn rơi xuống bậc thấp nhất.
  assert.equal(position.freshness, PositionFreshness.LIVE);
  assert.notEqual(position.freshness, PositionFreshness.NO_SOURCE_TIME);
});

test("tàu buộc bến: speed=0, course=0, navStatus=0 sống sót cả đường ống", async () => {
  const { details, resolved } = await runPipeline(
    detailHtml({ sog: 0, cog: 0, lrpd: "0 min ago", navStatus: "Under way using engine" })
  );

  assert.equal(details.position?.speed, 0);
  assert.equal(details.position?.course, 0);
  assert.equal(details.position?.navStatus?.code, 0);

  const position = resolved.position;
  assert.ok(position);
  // Ba assert này đỏ ngay khi ai đó viết `speed || null` ở bất kỳ mắt xích nào.
  assert.equal(position.position.speed, 0);
  assert.equal(position.position.course, 0);
  assert.equal(position.position.navStatus?.code, 0);
  assert.equal(position.observedAt?.toISOString(), FETCHED_AT.toISOString());
});

test("không có lrpd -> canonical observedAt null, KHÔNG mượn fetchedAt", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 3.2, cog: 90, lrpd: null, navStatus: "Moored" })
  );

  const position = resolved.position;
  assert.ok(position);
  assert.equal(position.observedAt, null);
  assert.equal(position.freshness, PositionFreshness.NO_SOURCE_TIME);
  // Vẫn giữ được motion — thiếu mốc thời gian không đồng nghĩa mất tốc độ/hướng.
  assert.equal(position.position.speed, 3.2);
  assert.equal(position.position.navStatus?.code, 5);
});

test("ô Navigation Status trống không tạo ra nhãn giả trong canonical", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 1.1, cog: 10, lrpd: "2 min ago", navStatus: "-" })
  );
  assert.equal(resolved.position?.position.navStatus, null);
});

test("COG 360 của AIS không lọt xuống canonical thành hướng đi thật", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 0, cog: 360, lrpd: "1 min ago", navStatus: "At anchor" })
  );
  const position = resolved.position;
  assert.ok(position);
  assert.equal(position.position.course, null);
  // speed = 0 vẫn phải còn: chỉ course bị loại.
  assert.equal(position.position.speed, 0);
  assert.equal(position.position.navStatus?.code, 1);
});

const MAP_SHIP: ScannedShip = { mmsi: MMSI, name: "PIPELINE TEST", lat: 51.234567, lon: 1.234567 };

test("§15 — discovery TRƯỚC, chi tiết SAU: motion và mốc nguồn tới được canonical", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP]
  );

  const position = resolved.position;
  assert.ok(position);
  assert.equal(position.position.speed, 9.4);
  assert.equal(position.position.course, 187);
  assert.equal(position.observedAt?.toISOString(), "2026-08-18T12:57:00.000Z");
  assert.equal(position.freshness, PositionFreshness.LIVE);
});

test("§15 — ĐÃ BIẾT: chu kỳ discovery SAU đó xoá motion khỏi canonical", async () => {
  // ⚠️ ĐÂY LÀ TEST ĐẶC TẢ HÀNH VI HIỆN TẠI, KHÔNG PHẢI HÀNH VI MONG MUỐN.
  //
  // `findLatestPerSourceByVesselAndType` trả về ĐÚNG MỘT observation cho mỗi
  // NGUỒN. Ô map và trang chi tiết cùng là `vesselfinder`, nên chúng KHÔNG BAO
  // GIỜ cùng vào tới resolver: ô map ghi sau sẽ CHE observation chi tiết, mang
  // theo speed/course/observedAt biến mất — dù resolver, nếu được thấy cả hai,
  // đã chọn đúng bản có mốc nguồn (test ngay phía trên chứng minh điều đó).
  //
  // Sửa đúng cách phải đổi cách NẠP ứng viên (repository/ResolveCurrentPosition),
  // tức là đổi chính sách resolver — nằm ngoài phạm vi PHASE 3 (§1, §2) và cần
  // proof riêng. Test này khoá hành vi lại để nó không âm thầm đổi.
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP],
    true
  );

  const position = resolved.position;
  assert.ok(position);
  // Ô map thắng vì nó MỚI HƠN theo fetchedAt, không phải vì nó tốt hơn.
  assert.equal(position.position.latLngApproximate, false);
  assert.equal(position.position.speed, undefined);
  assert.equal(position.position.course, undefined);
  assert.equal(position.observedAt, null);
  assert.equal(position.freshness, PositionFreshness.NO_SOURCE_TIME);
});
