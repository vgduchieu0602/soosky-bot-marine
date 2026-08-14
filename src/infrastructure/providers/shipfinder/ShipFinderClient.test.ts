// ============================================================================
//  TEST · ShipFinderClient — transport giả, KHÔNG chạm mạng
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHIPFINDER_BASE_URL,
  ShipFinderClient,
  ShipFinderHttpTransport,
} from "./ShipFinderClient";
import { FIXTURE_FULL_VESSEL } from "./shipFinderFixtures";

function fakeTransport(html = FIXTURE_FULL_VESSEL): {
  transport: ShipFinderHttpTransport;
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

test("URL công khai theo MMSI", () => {
  const client = new ShipFinderClient({ http: fakeTransport().transport });
  assert.equal(
    client.buildVesselUrl("636018086"),
    "https://www.shipfinder.com/ship/detail/mmsi/636018086"
  );
  assert.equal(SHIPFINDER_BASE_URL, "https://www.shipfinder.com");
});

test("nhận cả số, cắt khoảng trắng thừa", () => {
  const client = new ShipFinderClient({ http: fakeTransport().transport });
  assert.equal(
    client.buildVesselUrl(636018086),
    "https://www.shipfinder.com/ship/detail/mmsi/636018086"
  );
  assert.equal(
    client.buildVesselUrl("  636018086  "),
    "https://www.shipfinder.com/ship/detail/mmsi/636018086"
  );
});

test("fetchByMmsi gọi đúng URL và trả HTML thô", async () => {
  const { transport, calls } = fakeTransport();
  const client = new ShipFinderClient({ http: transport });

  const html = await client.fetchByMmsi("636018086");
  assert.equal(html, FIXTURE_FULL_VESSEL);
  assert.deepEqual(calls, ["https://www.shipfinder.com/ship/detail/mmsi/636018086"]);
});

test("client KHÔNG parse — trả nguyên chuỗi, kể cả trang không có tàu", async () => {
  const notFound = "<html>mọi ô là -</html>";
  const client = new ShipFinderClient({ http: fakeTransport(notFound).transport });
  // HTTP 200 không đồng nghĩa tàu tồn tại; client không được tự kết luận.
  assert.equal(await client.fetchByMmsi("636018086"), notFound);
});

test("MMSI không hợp lệ bị từ chối TRƯỚC khi gọi mạng", async () => {
  const { transport, calls } = fakeTransport();
  const client = new ShipFinderClient({ http: transport });

  for (const bad of [
    "12345", // quá ngắn
    "0123456789", // bắt đầu bằng 0
    "63601808a", // có chữ
    "../../etc/passwd", // chèn đường dẫn
    "636018086/x",
    "636018086?a=1",
    "",
    "   ",
  ]) {
    assert.throws(() => client.buildVesselUrl(bad), /MMSI không hợp lệ/, `phải chặn "${bad}"`);
  }
  await assert.rejects(() => client.fetchByMmsi("abc"), /MMSI không hợp lệ/);
  assert.deepEqual(calls, [], "không được phát request nào");
});

test("KHÔNG có lookup theo IMO / tìm theo tên", () => {
  const client = new ShipFinderClient({ http: fakeTransport().transport }) as unknown as Record<
    string,
    unknown
  >;
  // P7.1: /ship/detail/imo/... -> 404; tìm theo tên chỉ có qua API ký chữ ký.
  assert.equal(client.fetchByImo, undefined);
  assert.equal(client.searchByName, undefined);
});

test("mọi URL dựng ra đều nằm dưới đường công khai /ship/detail/mmsi/", () => {
  const client = new ShipFinderClient({ http: fakeTransport().transport });
  const url = client.buildVesselUrl("636018086");
  // Không chạm bất kỳ endpoint ký chữ ký nào (/Ship/GetShip, /ship/GetIHSData…).
  assert.match(url, /^https:\/\/www\.shipfinder\.com\/ship\/detail\/mmsi\/\d{9}$/);
  assert.equal(/\/Ship\/Get|\/ship\/Get|Suggest/i.test(url), false);
});

test("baseUrl đổi được, bỏ dấu / thừa", () => {
  const client = new ShipFinderClient({
    http: fakeTransport().transport,
    baseUrl: "http://localhost:8080///",
  });
  assert.equal(
    client.buildVesselUrl("636018086"),
    "http://localhost:8080/ship/detail/mmsi/636018086"
  );
});

test("client KHÔNG tự retry — mỗi lần gọi đúng một request", async () => {
  let attempts = 0;
  const client = new ShipFinderClient({
    http: {
      async getText(): Promise<string> {
        attempts += 1;
        throw new Error("nguồn hỏng");
      },
    },
  });

  // Retry/backoff thuộc SourceRequestExecutor (P4). Client không nhân bản.
  await assert.rejects(() => client.fetchByMmsi("636018086"), /nguồn hỏng/);
  assert.equal(attempts, 1);
});
