// ============================================================================
//  TEST · ShipInfoProvider — transport giả, KHÔNG chạm mạng
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderOperation,
  VesselDataProvider,
  getProviderOperations,
  providerSupportsOperation,
} from "../../../application/providers/VesselDataProvider";
import {
  SourceErrorCategory,
  SourceRequestError,
} from "../../../application/runtime/SourceError";
import { imoIdentifier, mmsiIdentifier } from "../../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../../domain/value-objects/VesselSource";
import { ShipInfoClient } from "./ShipInfoClient";
import { ShipInfoParseError } from "./ShipInfoParser";
import { ShipInfoProvider } from "./ShipInfoProvider";
import {
  FIXTURE_ALL_POINTS_INVALID,
  FIXTURE_MALFORMED_JSON,
  FIXTURE_MISSING_OPTIONAL_FIELDS,
  FIXTURE_NORMAL_VESSEL,
  FIXTURE_PHP_FATAL_ERROR,
  FIXTURE_POINTS_WITHOUT_SEO_ANCHOR,
  FIXTURE_SWAPPED_DIMENSIONS,
} from "./shipInfoFixtures";

const FETCHED_AT = new Date("2026-08-14T08:00:00.000Z");

function providerWith(html: string): { provider: ShipInfoProvider; calls: string[] } {
  const calls: string[] = [];
  const client = new ShipInfoClient({
    http: {
      async getText(url: string): Promise<string> {
        calls.push(url);
        return html;
      },
    },
  });
  return { provider: new ShipInfoProvider({ client, now: () => FETCHED_AT }), calls };
}

test("source = SHIPINFO", () => {
  assert.equal(providerWith(FIXTURE_NORMAL_VESSEL).provider.source, VesselSource.SHIPINFO);
});

test("chỉ hỗ trợ getDetails + getPosition; KHÔNG searchByName, KHÔNG scanArea", () => {
  const provider: VesselDataProvider = providerWith(FIXTURE_NORMAL_VESSEL).provider;

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

test("getDetails theo IMO -> URL đúng + canonical đầy đủ", async () => {
  const { provider, calls } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getDetails(imoIdentifier("9467976"));

  assert.deepEqual(calls, ["https://shipinfo.net/find_vessel_vessel_IMO-9467976_MMSI-0"]);
  assert.ok(result);
  assert.equal(result.identity?.name, "Agia Doxa");
  assert.equal(result.identity?.flag?.code, "LR");
  assert.equal(result.identity?.vesselType, "Bulk Carrier");
  assert.equal(result.particulars?.builtYear, 2010);
  assert.equal(result.particulars?.deadweight, 33261);
  assert.equal(result.position?.lat, 33.74968);
});

test("getDetails theo MMSI -> URL dùng IMO-0", async () => {
  const { provider, calls } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getDetails(mmsiIdentifier("636018086"));

  assert.deepEqual(calls, ["https://shipinfo.net/find_vessel_vessel_IMO-0_MMSI-636018086"]);
  assert.equal(result?.identity?.mmsi, "636018086");
});

test("getDetails KHÔNG trả nhóm voyage — nguồn không có destination/eta", async () => {
  const { provider } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getDetails(imoIdentifier("9467976"));
  assert.equal(result?.voyage, undefined);
});

test("getDetails: length/beam vắng mặt khỏi particulars", async () => {
  const { provider } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getDetails(imoIdentifier("9467976"));

  assert.equal(result?.particulars?.length, null);
  assert.equal(result?.particulars?.beam, null);
});

test("getDetails: tàu có kích thước ĐẢO -> không phát nhóm particulars nào", async () => {
  const { provider } = providerWith(FIXTURE_SWAPPED_DIMENSIONS);
  const result = await provider.getDetails(imoIdentifier("9656864"));

  assert.ok(result?.identity, "identity vẫn có");
  assert.equal(result?.particulars, undefined, "không year/dwt, và dimension bị bỏ -> không nhóm");
});

test("getDetails: tàu tồn tại nhưng không có vị trí -> chỉ thiếu nhóm position", async () => {
  const { provider } = providerWith(FIXTURE_MISSING_OPTIONAL_FIELDS);
  const result = await provider.getDetails(imoIdentifier("8913629"));

  assert.ok(result);
  assert.equal(result.identity?.name, "Admarine 100");
  assert.equal(result.position, undefined);
});

// ---- getPosition ----------------------------------------------------------

test("getPosition trả vị trí dùng được mới nhất + identity kèm theo", async () => {
  const { provider } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getPosition(imoIdentifier("9467976"));

  assert.ok(result);
  assert.equal(result.position.lat, 33.74968);
  assert.equal(result.position.lng, -118.20887);
  assert.equal(result.position.course, 58);
  assert.equal(result.identity?.name, "Agia Doxa");
});

test("getPosition: mốc thời gian là của NGUỒN, metadata tách fetchedAt", async () => {
  const { provider } = providerWith(FIXTURE_NORMAL_VESSEL);
  const result = await provider.getPosition(imoIdentifier("9467976"));

  assert.equal(result?.position.receivedAt.toISOString(), "2026-08-13T17:39:30.000Z");
  assert.equal(result?.position.metadata.source, VesselSource.SHIPINFO);
  assert.equal(result?.position.metadata.fetchedAt.getTime(), FETCHED_AT.getTime());
  assert.equal(
    result?.position.metadata.sourceReceivedAt?.toISOString(),
    "2026-08-13T17:39:30.000Z"
  );
  // Nhóm identity không có mốc nguồn -> null, không mượn của position.
  assert.equal(result?.identity?.metadata.sourceReceivedAt, null);
});

test("getPosition: points rỗng -> null, KHÔNG bịa toạ độ", async () => {
  const { provider } = providerWith(FIXTURE_MISSING_OPTIONAL_FIELDS);
  assert.equal(await provider.getPosition(imoIdentifier("8913629")), null);
});

test("getPosition: mọi toạ độ hỏng -> null", async () => {
  const { provider } = providerWith(FIXTURE_ALL_POINTS_INVALID);
  assert.equal(await provider.getPosition(imoIdentifier("9467976")), null);
});

test("getPosition: không suy được mốc thời gian -> null", async () => {
  const { provider } = providerWith(FIXTURE_POINTS_WITHOUT_SEO_ANCHOR);
  assert.equal(await provider.getPosition(imoIdentifier("9467976")), null);
});

// ---- NOT_FOUND vs PARSE_ERROR ---------------------------------------------

test("PHP fatal (HTTP 200) -> null, KHÔNG ném", async () => {
  const { provider } = providerWith(FIXTURE_PHP_FATAL_ERROR);

  assert.equal(await provider.getDetails(imoIdentifier("9467976")), null);
  assert.equal(await provider.getPosition(imoIdentifier("9467976")), null);
});

test("JSON hỏng -> NÉM PARSE_ERROR đã phân loại, KHÔNG biến thành not-found", async () => {
  const { provider } = providerWith(FIXTURE_MALFORMED_JSON);

  // Nguồn đổi định dạng khác hẳn tàu không tồn tại. Nuốt thành null sẽ âm thầm
  // xoá dữ liệu đang có ở phase sau.
  // Provider dịch lỗi riêng của nguồn sang category của P4; lỗi gốc giữ ở `cause`.
  const assertParseError = async (run: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof SourceRequestError);
      assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
      assert.equal(err.source, VesselSource.SHIPINFO);
      assert.ok(err.cause instanceof ShipInfoParseError, "giữ lỗi gốc của parser");
      return true;
    });
  };

  await assertParseError(() => provider.getDetails(imoIdentifier("9467976")));
  await assertParseError(() => provider.getPosition(imoIdentifier("9467976")));
});

// ---- Định danh ------------------------------------------------------------

test("định danh không hỗ trợ -> lỗi TRƯỚC khi gọi mạng", async () => {
  const { provider, calls } = providerWith(FIXTURE_NORMAL_VESSEL);
  const bogus = { type: "NAME", value: "EVER GIVEN" } as never;

  await assert.rejects(() => provider.getDetails(bogus), /không hỗ trợ định danh/);
  assert.deepEqual(calls, [], "không được phát request nào");
});

test("provider KHÔNG tự retry — một lần gọi, một request", async () => {
  let attempts = 0;
  const client = new ShipInfoClient({
    http: {
      async getText(): Promise<string> {
        attempts += 1;
        throw new Error("nguồn hỏng");
      },
    },
  });
  const provider = new ShipInfoProvider({ client });

  await assert.rejects(() => provider.getDetails(imoIdentifier("9467976")), /nguồn hỏng/);
  assert.equal(attempts, 1, "retry/backoff thuộc P4, không phải provider");
});
