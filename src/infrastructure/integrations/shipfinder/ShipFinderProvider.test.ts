// ============================================================================
//  TEST · ShipFinderProvider — transport giả, KHÔNG chạm mạng
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderOperation,
  VesselDataProvider,
  getProviderOperations,
  providerSupportsOperation,
} from "../../../application/contracts/providers/VesselDataProvider";
import {
  SourceErrorCategory,
  SourceRequestError,
} from "../../../application/services/crawl-runtime/SourceError";
import { imoIdentifier, mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { ShipFinderClient } from "./ShipFinderClient";
import { ShipFinderParseError } from "./ShipFinderParser";
import { ShipFinderProvider } from "./ShipFinderProvider";
import {
  FIXTURE_FULL_VESSEL,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_NOT_FOUND,
  FIXTURE_STRUCTURE_DRIFT,
} from "./shipFinderFixtures";

const MMSI = "636018086";
const FETCHED_AT = new Date("2026-08-14T16:00:00.000Z");
const OFFSET_UTC_PLUS_8 = 480;

function providerWith(
  html: string,
  options: { sourceUtcOffsetMinutes?: number } = {}
): { provider: ShipFinderProvider; calls: string[] } {
  const calls: string[] = [];
  const client = new ShipFinderClient({
    http: {
      async getText(url: string): Promise<string> {
        calls.push(url);
        return html;
      },
    },
  });
  return {
    calls,
    provider: new ShipFinderProvider({
      client,
      now: () => FETCHED_AT,
      sourceUtcOffsetMinutes: options.sourceUtcOffsetMinutes,
    }),
  };
}

test("source = SHIPFINDER", () => {
  assert.equal(providerWith(FIXTURE_FULL_VESSEL).provider.source, VesselSource.SHIPFINDER);
});

test("chỉ getDetails + getPosition; KHÔNG searchByName, KHÔNG scanArea", () => {
  const provider: VesselDataProvider = providerWith(FIXTURE_FULL_VESSEL).provider;

  assert.equal(provider.searchByName, undefined);
  assert.equal(provider.scanArea, undefined);
  assert.equal(providerSupportsOperation(provider, ProviderOperation.SEARCH_BY_NAME), false);
  assert.equal(providerSupportsOperation(provider, ProviderOperation.SCAN_AREA), false);
  assert.deepEqual(
    [...getProviderOperations(provider)],
    [ProviderOperation.GET_POSITION, ProviderOperation.GET_DETAILS]
  );
});

// ---- getDetails -----------------------------------------------------------

test("getDetails theo MMSI -> URL đúng + canonical đầy đủ", async () => {
  const { provider, calls } = providerWith(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await provider.getDetails(mmsiIdentifier(MMSI));

  assert.deepEqual(calls, [`https://www.shipfinder.com/ship/detail/mmsi/${MMSI}`]);
  assert.ok(result);
  assert.equal(result.identity?.name, "AGIA DOXA");
  assert.equal(result.identity?.flag?.code, "LBR");
  assert.equal(result.identity?.vesselType, "Cargo ship");
  assert.equal(result.particulars?.length, 179);
  assert.equal(result.particulars?.beam, 29);
  assert.equal(result.particulars?.draught, 5.9);
  assert.equal(result.voyage?.destination, "LONG BEACH, US");
  assert.ok(result.position);
});

test("getDetails: nhóm voyage có destination nhưng eta null", async () => {
  const { provider } = providerWith(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await provider.getDetails(mmsiIdentifier(MMSI));

  assert.equal(result?.voyage?.destination, "LONG BEACH, US");
  assert.equal(result?.voyage?.eta, null, "ETA thiếu năm -> không bịa");
});

test("getDetails KHÔNG khai offset -> có identity/particulars/voyage, THIẾU position", async () => {
  const { provider } = providerWith(FIXTURE_FULL_VESSEL); // không truyền offset
  const result = await provider.getDetails(mmsiIdentifier(MMSI));

  assert.ok(result);
  assert.ok(result.identity, "identity vẫn có");
  assert.ok(result.particulars, "particulars vẫn có");
  assert.ok(result.voyage, "voyage vẫn có");
  // Một nhóm không xác định được không làm hỏng cả operation.
  assert.equal(result.position, undefined, "không mốc thời gian -> không phát vị trí");
});

test("getDetails: tàu thiếu field tuỳ chọn -> chỉ thiếu nhóm tương ứng", async () => {
  const { provider } = providerWith(FIXTURE_MISSING_OPTIONAL_FIELDS, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await provider.getDetails(mmsiIdentifier(MMSI));

  assert.ok(result);
  assert.equal(result.identity?.name, "NO FRILLS");
  assert.equal(result.particulars, undefined, "không có kích thước -> không nhóm");
  assert.equal(result.voyage, undefined, "không có destination -> không nhóm");
  assert.ok(result.position, "vẫn có toạ độ + mốc thời gian");
});

// ---- getPosition ----------------------------------------------------------

test("getPosition trả vị trí + identity kèm theo", async () => {
  const { provider } = providerWith(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await provider.getPosition(mmsiIdentifier(MMSI));

  assert.ok(result);
  assert.ok(Math.abs(result.position.lat - 33.7497167) < 1e-4);
  assert.ok(Math.abs(result.position.lng - -118.20885) < 1e-4);
  assert.equal(result.position.speed, 0);
  assert.equal(result.position.course, 0.9);
  assert.equal(result.position.heading, 58);
  assert.equal(result.position.navStatus?.text, "Moored");
  assert.equal(result.identity?.name, "AGIA DOXA");
});

test("getPosition: metadata tách fetchedAt khỏi sourceReceivedAt", async () => {
  const { provider } = providerWith(FIXTURE_FULL_VESSEL, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  const result = await provider.getPosition(mmsiIdentifier(MMSI));

  assert.equal(result?.position.receivedAt.toISOString(), "2026-08-14T15:51:36.000Z");
  assert.equal(result?.position.metadata.source, VesselSource.SHIPFINDER);
  assert.equal(result?.position.metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.equal(
    result?.position.metadata.sourceReceivedAt?.toISOString(),
    "2026-08-14T15:51:36.000Z"
  );
  // Nhóm identity không có mốc nguồn -> null, không mượn của position.
  assert.equal(result?.identity?.metadata.sourceReceivedAt, null);
});

test("getPosition KHÔNG khai offset -> null, KHÔNG lấy fetchedAt làm mốc", async () => {
  const { provider } = providerWith(FIXTURE_FULL_VESSEL);
  assert.equal(await provider.getPosition(mmsiIdentifier(MMSI)), null);
});

// ---- NOT_FOUND vs PARSE_ERROR ---------------------------------------------

test("HTTP 200 + mọi ô \"-\" -> null, KHÔNG ném", async () => {
  const { provider } = providerWith(FIXTURE_NOT_FOUND, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });
  assert.equal(await provider.getDetails(mmsiIdentifier(MMSI)), null);
  assert.equal(await provider.getPosition(mmsiIdentifier(MMSI)), null);
});

test("parser drift -> NÉM PARSE_ERROR đã phân loại, KHÔNG biến thành not-found", async () => {
  const { provider } = providerWith(FIXTURE_STRUCTURE_DRIFT, {
    sourceUtcOffsetMinutes: OFFSET_UTC_PLUS_8,
  });

  // Nguồn đổi cấu trúc khác hẳn tàu không tồn tại. Provider dịch lỗi riêng của
  // nguồn sang category của P4; lỗi gốc giữ ở `cause`.
  const assertParseError = async (run: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof SourceRequestError);
      assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
      assert.equal(err.source, VesselSource.SHIPFINDER);
      assert.ok(err.cause instanceof ShipFinderParseError, "giữ lỗi gốc của parser");
      return true;
    });
  };

  await assertParseError(() => provider.getDetails(mmsiIdentifier(MMSI)));
  await assertParseError(() => provider.getPosition(mmsiIdentifier(MMSI)));
});

// ---- Định danh ------------------------------------------------------------

test("định danh IMO -> lỗi TRƯỚC khi gọi mạng, KHÔNG ghép IMO vào URL mmsi", async () => {
  const { provider, calls } = providerWith(FIXTURE_FULL_VESSEL);

  await assert.rejects(
    () => provider.getDetails(imoIdentifier("9467976")),
    /chỉ hỗ trợ định danh MMSI/
  );
  await assert.rejects(
    () => provider.getPosition(imoIdentifier("9467976")),
    /không có đường tra theo IMO/
  );
  assert.deepEqual(calls, [], "không được phát request nào");
});

test("provider KHÔNG tự retry — một lần gọi, một request", async () => {
  let attempts = 0;
  const client = new ShipFinderClient({
    http: {
      async getText(): Promise<string> {
        attempts += 1;
        throw new Error("nguồn hỏng");
      },
    },
  });
  const provider = new ShipFinderProvider({ client });

  await assert.rejects(() => provider.getDetails(mmsiIdentifier(MMSI)), /nguồn hỏng/);
  assert.equal(attempts, 1, "retry/backoff thuộc P4, không phải provider");
});
