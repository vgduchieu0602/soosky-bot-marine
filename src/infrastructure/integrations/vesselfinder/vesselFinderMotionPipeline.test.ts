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

test("§11 — discovery TRƯỚC, chi tiết SAU: toạ độ của map, motion của chi tiết", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP]
  );

  const position = resolved.position;
  assert.ok(position);
  // Toạ độ: ô map còn liên quan và chính xác hơn -> thắng.
  assert.equal(position.position.latLngApproximate, false);
  // Khối toạ độ khai TRUNG THỰC rằng ô map không cho mốc nguồn.
  assert.equal(position.observedAt, null);
  assert.equal(position.freshness, PositionFreshness.NO_SOURCE_TIME);
  // Chuyển động nằm ở khối riêng, mang mốc nguồn của chính nó.
  assert.ok(position.motion);
  assert.equal(position.motion.speed, 9.4);
  assert.equal(position.motion.course, 187);
  assert.equal(position.motion.observedAt?.toISOString(), "2026-08-18T12:57:00.000Z");
  assert.equal(position.motion.freshness, PositionFreshness.LIVE);
});

test("§20 — chu kỳ map SAU KHI tra chi tiết KHÔNG còn xoá motion", async () => {
  // Đây chính là lỗi PHASE 3.1 phải sửa. Trước đây ô map ghi sau che mất
  // observation chi tiết, kéo theo speed/course/navStatus/observedAt biến mất.
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP],
    true
  );

  const position = resolved.position;
  assert.ok(position);

  // Toạ độ: lấy của ô map, CHÍNH XÁC hơn trang chi tiết bị làm tròn.
  assert.equal(position.position.latLngApproximate, false);
  assert.equal(position.position.lat, MAP_SHIP.lat);
  assert.equal(position.position.lng, MAP_SHIP.lon);

  // Chuyển động: vẫn còn, kèm mốc thời gian CỦA CHÍNH NÓ.
  assert.ok(position.motion, "motion phải sống sót qua chu kỳ map");
  assert.equal(position.motion.speed, 9.4);
  assert.equal(position.motion.course, 187);
  assert.equal(position.motion.navStatus?.code, 0);
  assert.equal(position.motion.observedAt?.toISOString(), "2026-08-18T11:57:00.000Z");
  // Lúc phân xử (13:00) chuyển động đã 63 phút tuổi -> RECENT mới là sự thật.
  // Gắn nhãn LIVE ở đây chính là kiểu nói dối mà §33 cấm.
  assert.equal(position.motion.freshness, PositionFreshness.RECENT);
});

test("§21 — thứ tự ngược lại cho cùng một kết quả ngữ nghĩa", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP],
    false
  );
  const position = resolved.position;
  assert.ok(position);
  assert.ok(position.motion);
  assert.equal(position.motion.speed, 9.4);
  assert.equal(position.motion.course, 187);
  assert.equal(position.motion.navStatus?.code, 0);
});

test("§22 — giá trị 0 vẫn còn sau chu kỳ map", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 0, cog: 0, lrpd: "0 min ago", navStatus: "Under way using engine" }),
    [MAP_SHIP],
    true
  );
  const motion = resolved.position?.motion;
  assert.ok(motion);
  // 0 là giá trị. `speed ?? fallback` / `speed || null` làm ba assert này đỏ.
  assert.equal(motion.speed, 0);
  assert.equal(motion.course, 0);
  assert.equal(motion.navStatus?.code, 0);
});

test("§14/§15 — fetchedAt của ô map KHÔNG làm mới motion", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 min ago", navStatus: "Moored" }),
    [MAP_SHIP],
    true
  );
  const position = resolved.position;
  assert.ok(position?.motion);
  // Ô map được lấy lúc 13:00; motion vẫn khai đúng mốc nguồn 11:57 của nó.
  assert.equal(position.motion.observedAt?.toISOString(), "2026-08-18T11:57:00.000Z");
  assert.notEqual(
    position.motion.observedAt?.toISOString(),
    position.fetchedAt.toISOString()
  );
  assert.equal(position.motion.fetchedAt.toISOString(), FETCHED_AT.toISOString());
});

test("§23 — motion quá hạn KHÔNG được mang sang như thể còn tươi", async () => {
  // lrpd 3 ngày -> vượt staleMaxAgeMs (24h) -> bậc EXPIRED.
  const { resolved } = await runPipeline(
    detailHtml({ sog: 9.4, cog: 187, lrpd: "3 days ago", navStatus: "Moored" }),
    [MAP_SHIP],
    true
  );
  const position = resolved.position;
  assert.ok(position);
  // Toạ độ vẫn dùng được; chuyển động thì thà THIẾU còn hơn bịa là tươi.
  assert.equal(position.position.latLngApproximate, false);
  assert.equal(position.motion, null);
});

test("§26 — chi tiết KHÔNG có lrpd: motion giữ lại nhưng KHÔNG được gắn nhãn LIVE", async () => {
  const { resolved } = await runPipeline(
    detailHtml({ sog: 3.2, cog: 90, lrpd: null, navStatus: "Moored" }),
    [MAP_SHIP],
    true
  );
  const position = resolved.position;
  assert.ok(position);
  assert.ok(position.motion);
  assert.equal(position.motion.speed, 3.2);
  assert.equal(position.motion.observedAt, null);
  assert.equal(position.motion.freshness, PositionFreshness.NO_SOURCE_TIME);
  assert.notEqual(position.motion.freshness, PositionFreshness.LIVE);
});

test("§24 — nhiều bản chi tiết: motion lấy của bản MỚI NHẤT còn hợp lệ", async () => {
  let clock = FETCHED_AT;
  const repository = new InMemoryVesselObservationRepository({ now: () => clock });
  const recorder = new ObservationRecorder({ repository, now: () => clock });

  const detail = async (sog: number, cog: number, lrpd: string) => {
    const provider = providerOver(detailHtml({ sog, cog, lrpd, navStatus: "Moored" }), [], () => clock);
    await recorder.recordDetails((await provider.getDetails(mmsiIdentifier(MMSI)))!);
  };

  await detail(2.1, 10, "2 min ago"); // chi tiết CŨ
  clock = new Date(clock.getTime() + 30 * 60 * 1000);
  await detail(8.8, 200, "1 min ago"); // chi tiết MỚI
  clock = new Date(clock.getTime() + 30 * 60 * 1000);
  const mapProvider = providerOver(detailHtml({}), [MAP_SHIP], () => clock);
  await recorder.recordPositions(await mapProvider.scanArea(BOX)); // ô map SAU CÙNG

  const resolved = await new ResolveCurrentVessel({ repository, now: () => clock }).execute({
    mmsi: MMSI,
  });
  const motion = resolved?.position?.motion;
  assert.ok(motion);
  assert.equal(motion.speed, 8.8);
  assert.equal(motion.course, 200);
});

test("§25 — motion KHÔNG hợp lệ không được làm bẩn canonical", async () => {
  // cog 360 và sog 102.3 là mã "không có" của AIS. Mapper loại chúng thành null,
  // nên bản chi tiết này KHÔNG mang chuyển động nào dùng được.
  const { resolved } = await runPipeline(
    detailHtml({ sog: 102.3, cog: 360, lrpd: "2 min ago", navStatus: "-" }),
    [MAP_SHIP],
    true
  );
  const position = resolved.position;
  assert.ok(position);
  assert.equal(position.position.latLngApproximate, false); // toạ độ map vẫn dùng được
  assert.equal(position.motion, null); // không có gì để mang sang
});
