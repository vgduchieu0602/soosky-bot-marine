// ============================================================================
//  TEST · VesselFinderProvider — bọc legacy source, KHÔNG bịa dữ liệu
// ----------------------------------------------------------------------------
//  Source legacy được giả lập hoàn toàn: không mạng, không DB.
//  Test quan trọng nhất: mp2 chỉ có 4 field -> provider tuyệt đối không sinh ra
//  speed/course/heading/navStatus, và không lấy fetchedAt làm sourceReceivedAt.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundingBox } from "../../../application/contracts/geo/Geo";
import { IAreaScanner, ScannedShip } from "../../../application/contracts/geo/IAreaScanner";
import {
  IVesselDetailsSource,
  VesselDetails,
} from "../../../application/contracts/providers/IVesselDetailsSource";
import {
  ProviderOperation,
  VesselDataProvider,
  getProviderOperations,
  providerSupportsOperation,
} from "../../../application/contracts/providers/VesselDataProvider";
import { Vessel } from "../../../legacy/entities/Vessel";
import { VesselPosition } from "../../../legacy/entities/VesselPosition";
import { AppError } from "../../../domain/errors/AppError";
import { mmsiIdentifier, imoIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { VesselFinderProvider } from "./VesselFinderProvider";

const FETCHED_AT = new Date("2026-08-13T10:00:00.000Z");
const BOX: BoundingBox = { minLat: 1, minLon: 103, maxLat: 2, maxLon: 104 };

/** Trang chi tiết VesselFinder đã bóc xong, đúng những field mapper thật lấy. */
function legacyDetails(): VesselDetails {
  return {
    vessel: new Vessel({
      mmsi: "305803000",
      imo: "9074729",
      name: "TEST CARRIER",
      type: "Container Ship",
      callsign: "V2GZ",
      country: "Antigua",
      lengthM: 134,
      widthM: 22,
      draughtM: 7.4,
    }),
    position: new VesselPosition({
      mmsi: "305803000",
      imo: "9074729",
      lat: 1.5,
      lon: 103.5,
      speedKn: 12.3,
      courseDeg: 187,
      navStatusText: "Under way using engine",
      positionTime: "0 min ago",
      source: "vesselfinder",
      latLonApproximate: true, // trang chi tiết làm tròn toạ độ
      receivedAt: "2026-08-13T09:59:00.000Z",
    }),
  };
}

function detailsSourceReturning(
  details: VesselDetails | Error,
  calls: string[] = []
): IVesselDetailsSource {
  return {
    async getDetails(id: string): Promise<VesselDetails> {
      calls.push(id);
      if (details instanceof Error) throw details;
      return details;
    },
  };
}

function areaScannerReturning(ships: ScannedShip[]): IAreaScanner {
  return {
    async fetchArea(): Promise<ScannedShip[]> {
      return ships;
    },
  };
}

function buildProvider(deps: {
  detailsSource?: IVesselDetailsSource;
  areaScanner?: IAreaScanner;
}): VesselFinderProvider {
  return new VesselFinderProvider({
    detailsSource: deps.detailsSource ?? detailsSourceReturning(legacyDetails()),
    areaScanner: deps.areaScanner ?? areaScannerReturning([]),
    now: () => FETCHED_AT,
  });
}

test("source = VESSELFINDER", () => {
  assert.equal(buildProvider({}).source, VesselSource.VESSELFINDER);
});

test("operation không hỗ trợ thì method KHÔNG tồn tại (searchByName)", () => {
  // Nhìn qua interface: class thậm chí không khai báo method này -> truy cập
  // trực tiếp trên class là lỗi biên dịch, đó chính là điều ta muốn.
  const provider: VesselDataProvider = buildProvider({});
  assert.equal(provider.searchByName, undefined);
  assert.equal(providerSupportsOperation(provider, ProviderOperation.SEARCH_BY_NAME), false);
  assert.deepEqual(
    [...getProviderOperations(provider)],
    [ProviderOperation.GET_POSITION, ProviderOperation.GET_DETAILS, ProviderOperation.SCAN_AREA]
  );
});

test("getDetails map legacy -> canonical đúng tên và đơn vị", async () => {
  const result = await buildProvider({}).getDetails(mmsiIdentifier("305803000"));
  assert.ok(result);

  assert.equal(result.identity?.mmsi, "305803000");
  assert.equal(result.identity?.imo, "9074729");
  assert.equal(result.identity?.name, "TEST CARRIER");
  assert.equal(result.identity?.vesselType, "Container Ship");
  assert.equal(result.identity?.callsign, "V2GZ");
  assert.equal(result.identity?.flag?.name, "Antigua");

  // lengthM/widthM/draughtM -> length/beam/draught, giá trị giữ nguyên (mét).
  assert.equal(result.particulars?.length, 134);
  assert.equal(result.particulars?.beam, 22);
  assert.equal(result.particulars?.draught, 7.4);

  // lon -> lng, chuỗi ISO -> Date.
  assert.equal(result.position?.lat, 1.5);
  assert.equal(result.position?.lng, 103.5);
  assert.equal(result.position?.speed, 12.3);
  assert.equal(result.position?.course, 187);
  assert.equal(result.position?.navStatus?.text, "Under way using engine");
  assert.equal(result.position?.latLngApproximate, true);
  assert.equal(result.position?.receivedAt instanceof Date, true);
  assert.equal(result.position?.receivedAt.toISOString(), "2026-08-13T09:59:00.000Z");
});

test("getDetails KHÔNG trả nhóm voyage — mapper hiện không bóc destination/eta", async () => {
  const result = await buildProvider({}).getDetails(mmsiIdentifier("305803000"));
  assert.equal(result?.voyage, undefined);
});

test("metadata: source=VESSELFINDER, fetchedAt là Date, sourceReceivedAt null", async () => {
  const result = await buildProvider({}).getDetails(imoIdentifier("9074729"));
  const metadata = result?.identity?.metadata;

  assert.equal(metadata?.source, VesselSource.VESSELFINDER);
  assert.equal(metadata?.fetchedAt instanceof Date, true);
  assert.equal(metadata?.fetchedAt.getTime(), FETCHED_AT.getTime());
  // "0 min ago" là chuỗi tương đối -> KHÔNG được dùng làm mốc của nguồn.
  assert.equal(metadata?.sourceReceivedAt, null);
  // Mọi nhóm dùng chung một metadata của lần gọi đó.
  assert.equal(result?.particulars?.metadata.source, VesselSource.VESSELFINDER);
  assert.equal(result?.position?.metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
});

test("identifier chỉ truyền phần value xuống source cũ (giữ tương thích redirect)", async () => {
  const calls: string[] = [];
  const provider = buildProvider({
    detailsSource: detailsSourceReturning(legacyDetails(), calls),
  });

  await provider.getDetails(mmsiIdentifier("305803000"));
  await provider.getDetails(imoIdentifier("9074729"));
  assert.deepEqual(calls, ["305803000", "9074729"]);
});

test("tàu không tồn tại (E-1001) -> null; lỗi khác thì NÉM TIẾP", async () => {
  const notFound = buildProvider({
    detailsSource: detailsSourceReturning(new AppError("E-1001", "Không tìm thấy tàu")),
  });
  assert.equal(await notFound.getDetails(mmsiIdentifier("305803000")), null);
  assert.equal(await notFound.getPosition(mmsiIdentifier("305803000")), null);

  // Bị chặn / timeout / parse hỏng KHÔNG được nuốt thành "không có tàu".
  const blocked = buildProvider({
    detailsSource: detailsSourceReturning(new AppError("E-2001", "Bị chặn")),
  });
  await assert.rejects(() => blocked.getDetails(mmsiIdentifier("305803000")), /Bị chặn/);
});

test("getPosition trả vị trí + identity, giữ cờ toạ độ làm tròn của trang chi tiết", async () => {
  const result = await buildProvider({}).getPosition(mmsiIdentifier("305803000"));
  assert.equal(result?.position.lat, 1.5);
  assert.equal(result?.position.latLngApproximate, true);
  assert.equal(result?.identity?.name, "TEST CARRIER");
});

test("scanArea KHÔNG bịa speed/course/heading/navStatus — mp2 không có", async () => {
  const provider = buildProvider({
    areaScanner: areaScannerReturning([
      { mmsi: "305803000", name: "TEST CARRIER", lat: 1.5, lon: 103.5 },
    ]),
  });

  const [result] = await provider.scanArea(BOX);
  const position = result.position;

  // Field vắng mặt hoàn toàn, không phải null cho đủ bộ.
  assert.equal("speed" in position, false);
  assert.equal("course" in position, false);
  assert.equal("heading" in position, false);
  assert.equal("navStatus" in position, false);

  // 4 field mp2 thật sự có.
  assert.equal(position.mmsi, "305803000");
  assert.equal(position.lat, 1.5);
  assert.equal(position.lng, 103.5);
  assert.equal(result.identity?.name, "TEST CARRIER");
  // mp2 cho toạ độ chính xác, khác trang chi tiết.
  assert.equal(position.latLngApproximate, false);
  // mp2 không kèm timestamp của nguồn.
  assert.equal(position.metadata.sourceReceivedAt, null);
  assert.equal(position.receivedAt.getTime(), FETCHED_AT.getTime());
});

test("scanArea: name = mmsi là chỗ giữ chỗ của decoder -> canonical trả null", async () => {
  const provider = buildProvider({
    areaScanner: areaScannerReturning([
      { mmsi: "305803000", name: "305803000", lat: 1.5, lon: 103.5 },
      { mmsi: "305803001", name: "   ", lat: 1.6, lon: 103.6 },
    ]),
  });

  const results = await provider.scanArea(BOX);
  assert.equal(results[0].identity?.name, null);
  assert.equal(results[1].identity?.name, null);
});

test("scanArea loại bản ghi thiếu khoá/toạ độ rác, trả mảng đóng băng", async () => {
  const provider = buildProvider({
    areaScanner: areaScannerReturning([
      { mmsi: "", name: "NO KEY", lat: 1.5, lon: 103.5 },
      { mmsi: "305803000", name: "OK", lat: Number.NaN, lon: 103.5 },
      { mmsi: "305803001", name: "GOOD", lat: 1.6, lon: 103.6 },
    ]),
  });

  const results = await provider.scanArea(BOX);
  assert.equal(results.length, 1);
  assert.equal(results[0].position.mmsi, "305803001");
  assert.equal(Object.isFrozen(results), true);
});

test("scanArea vùng rỗng -> mảng rỗng, không ném", async () => {
  assert.deepEqual([...(await buildProvider({}).scanArea(BOX))], []);
});
