// ============================================================================
//  TEST · ShipInfoClient — dựng URL + GET. Transport giả, KHÔNG chạm mạng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { SHIPINFO_BASE_URL, ShipInfoClient, ShipInfoHttpTransport } from "./ShipInfoClient";
import { FIXTURE_NORMAL_VESSEL } from "./shipInfoFixtures";

/** Transport giả: ghi lại URL đã gọi, trả HTML cố định. */
function fakeTransport(html = FIXTURE_NORMAL_VESSEL): {
  transport: ShipInfoHttpTransport;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async getText(url: string): Promise<string> {
        calls.push(url);
        return html;
      },
    },
  };
}

test("URL tra theo IMO: MMSI để trống bằng 0", () => {
  const { transport } = fakeTransport();
  const client = new ShipInfoClient({ http: transport });

  assert.equal(
    client.buildVesselUrl({ imo: "9467976" }),
    "https://shipinfo.net/find_vessel_vessel_IMO-9467976_MMSI-0"
  );
});

test("URL tra theo MMSI: IMO để trống bằng 0", () => {
  const { transport } = fakeTransport();
  const client = new ShipInfoClient({ http: transport });

  assert.equal(
    client.buildVesselUrl({ mmsi: "414708000" }),
    "https://shipinfo.net/find_vessel_vessel_IMO-0_MMSI-414708000"
  );
});

test("có cả hai thì đặt cả hai", () => {
  const client = new ShipInfoClient({ http: fakeTransport().transport });
  assert.equal(
    client.buildVesselUrl({ imo: "9467976", mmsi: "636018086" }),
    "https://shipinfo.net/find_vessel_vessel_IMO-9467976_MMSI-636018086"
  );
});

test("tên trong URL là hằng số — client KHÔNG giả vờ biết tên tàu", () => {
  const client = new ShipInfoClient({ http: fakeTransport().transport });
  const url = client.buildVesselUrl({ imo: "9467976" });

  // P6.1: sai tên vẫn trả đúng tàu; sitemap của chính ShipInfo còn ghi tên cũ.
  assert.match(url, /find_vessel_vessel_IMO-/);
  assert.equal(url.includes("Agia"), false);
});

test("fetchByImo / fetchByMmsi gọi đúng URL và trả HTML thô", async () => {
  const { transport, calls } = fakeTransport();
  const client = new ShipInfoClient({ http: transport });

  const html = await client.fetchByImo("9467976");
  assert.equal(html, FIXTURE_NORMAL_VESSEL);

  await client.fetchByMmsi("414708000");
  assert.deepEqual(calls, [
    "https://shipinfo.net/find_vessel_vessel_IMO-9467976_MMSI-0",
    "https://shipinfo.net/find_vessel_vessel_IMO-0_MMSI-414708000",
  ]);
});

test("client KHÔNG parse — trả nguyên chuỗi, kể cả body lỗi", async () => {
  const fatal = "<b>Fatal error</b>: ...";
  const { transport } = fakeTransport(fatal);
  const client = new ShipInfoClient({ http: transport });

  // HTTP 200 không đồng nghĩa tàu tồn tại; client không được tự kết luận.
  assert.equal(await client.fetchByImo("9467976"), fatal);
});

test("định danh không phải chữ số bị từ chối TRƯỚC khi gọi mạng", async () => {
  const { transport, calls } = fakeTransport();
  const client = new ShipInfoClient({ http: transport });

  for (const bad of ["../../etc/passwd", "94a67976", "", "  ", "9467976/x", "9467976?a=1"]) {
    assert.throws(() => client.buildVesselUrl({ imo: bad }), /phải là chuỗi 1-12 chữ số/);
  }
  await assert.rejects(() => client.fetchByMmsi("abc"), /chuỗi 1-12 chữ số/);
  assert.deepEqual(calls, [], "không được phát request nào");
});

test("không có định danh nào -> lỗi", () => {
  const client = new ShipInfoClient({ http: fakeTransport().transport });
  assert.throws(() => client.buildVesselUrl({}), /ít nhất một trong IMO hoặc MMSI/);
});

test("KHÔNG kiểm checksum IMO — trang thật có IMO sai checksum", () => {
  const client = new ShipInfoClient({ http: fakeTransport().transport });
  // P6.1: IMO 9999999 sai checksum ISO 8713 nhưng là trang tàu THẬT
  // (ROSA DEI VENTI, 177 điểm track). Siết checksum sẽ chặn lookup chạy được.
  assert.equal(
    client.buildVesselUrl({ imo: "9999999" }),
    "https://shipinfo.net/find_vessel_vessel_IMO-9999999_MMSI-0"
  );
});

test("baseUrl đổi được, bỏ dấu / thừa", () => {
  const client = new ShipInfoClient({
    http: fakeTransport().transport,
    baseUrl: "http://localhost:8080///",
  });
  assert.equal(
    client.buildVesselUrl({ imo: "9467976" }),
    "http://localhost:8080/find_vessel_vessel_IMO-9467976_MMSI-0"
  );
  assert.equal(SHIPINFO_BASE_URL, "https://shipinfo.net");
});

test("client KHÔNG tự retry — mỗi lần gọi đúng một request", async () => {
  let attempts = 0;
  const client = new ShipInfoClient({
    http: {
      async getText(): Promise<string> {
        attempts += 1;
        throw new Error("nguồn hỏng");
      },
    },
  });

  // Retry/backoff thuộc SourceRequestExecutor (P4). Client không được nhân bản.
  await assert.rejects(() => client.fetchByImo("9467976"), /nguồn hỏng/);
  assert.equal(attempts, 1);
});
