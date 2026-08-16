// ============================================================================
//  TEST · MarineAisWebSocketClient — chạy với WS server GIẢ ở localhost
// ----------------------------------------------------------------------------
//  ⛔ KHÔNG test nào chạm production, chạm internet, hay chạm stream.aisstream.io.
//  Server giả bắt chước đúng hai hành vi đã audit của `Server._initInternalWss`:
//      • path `/ais-stream`
//      • gửi frame chào `{"message":"Connected to ..."}` ngay khi client nối
//
//  Mọi khoảng chờ reconnect trong file này là 10–20ms, không phải giây.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { VesselSource } from "../../../domain/enums/VesselSource";
import { MarineAisRejectReason } from "./MarineAisMessageMapper";
import {
  MarineAisClientEvent,
  MarineAisFrameRejectReason,
  MarineAisNormalizedEvent,
  MarineAisRejection,
  MarineAisWebSocketClient,
} from "./MarineAisWebSocketClient";

/** Đồng hồ BOT cố định -> mốc trong assert là tất định. */
const NOW = new Date("2026-08-16T12:10:00.000Z");
const AIS_TIME = "2026-08-16 12:09:42.123456789 +0000 UTC";

const POSITION_FRAME = JSON.stringify({
  type: "PositionReport",
  data: {
    mmsi: 636018086,
    latlng: [33.749667, -118.20895],
    sog: 10.6,
    cog: 123,
    timestamp: AIS_TIME,
    navigationalStatus: 5,
  },
});

const STATIC_FRAME = JSON.stringify({
  type: "ShipStaticData",
  data: { mmsi: 636018086, imo: 9074729, type: 70, name: "AGIA DOXA" },
});

/** Đúng hợp đồng nhưng MMSI vô nghĩa -> mapper loại, socket phải sống. */
const BAD_MMSI_FRAME = JSON.stringify({
  type: "PositionReport",
  data: {
    mmsi: 12345,
    latlng: [33.7, -118.2],
    sog: 10,
    cog: 100,
    timestamp: AIS_TIME,
    navigationalStatus: 0,
  },
});

const SILENT_LOGGER = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
//  Server giả
// ---------------------------------------------------------------------------

interface FakeServer {
  url: string;
  /** Mọi socket server đã nhận — dùng để đếm số connection thật. */
  readonly accepted: WebSocket[];
  broadcast(raw: string): void;
  dropClients(): void;
  close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ais-stream" });
  await once(server, "listening");

  const accepted: WebSocket[] = [];
  server.on("connection", (socket) => {
    accepted.push(socket);
    // Không có listener `error` thì socket bị terminate sẽ ném ra ngoài test.
    socket.on("error", () => {});
    // Giống production: chào ngay khi có client.
    socket.send(JSON.stringify({ message: "Connected to Soosky Marine WebSocket Server!" }));
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ais-stream`,
    accepted,
    broadcast(raw) {
      for (const socket of accepted) {
        if (socket.readyState === WebSocket.OPEN) socket.send(raw);
      }
    },
    dropClients() {
      for (const socket of accepted) socket.close();
    },
    async close() {
      for (const socket of accepted) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function buildClient(url: string, overrides: Record<string, unknown> = {}) {
  return new MarineAisWebSocketClient({
    url,
    now: () => NOW,
    initialReconnectDelayMs: 10,
    maxReconnectDelayMs: 20,
    closeTimeoutMs: 200,
    logger: SILENT_LOGGER,
    ...overrides,
  });
}

/** Chờ tới khi điều kiện đúng. Không `sleep` mù. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil hết giờ");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
//  §27 · Kết nối
// ---------------------------------------------------------------------------

test("§27 client kết nối được vào WS giả, đúng MỘT connection", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    assert.equal(client.isActive(), true);
    assert.equal(server.accepted.length, 1);
    assert.equal(client.getStats().connections, 1);
  } finally {
    await client.stop();
    await server.close();
  }
});

test("frame chào của server KHÔNG bị tính là lệch hợp đồng", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);
    await waitUntil(() => client.getStats().serverNotices === 1);

    const stats = client.getStats();
    assert.equal(stats.serverNotices, 1);
    assert.equal(stats.contractMismatch, 0);
    assert.equal(stats.malformedJson, 0);
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §28 · PositionReport hợp lệ
// ---------------------------------------------------------------------------

test("§28 PositionReport -> normalizedData, canonical AISSTREAM", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const emitted = once(client, MarineAisClientEvent.NORMALIZED_DATA);
    server.broadcast(POSITION_FRAME);
    const [event] = (await emitted) as [MarineAisNormalizedEvent];

    assert.equal(event.type, "PositionReport");
    assert.equal(event.mmsi, "636018086");
    assert.equal(event.receivedAt.toISOString(), NOW.toISOString());

    const position = event.result.position;
    assert.equal(event.result.identity, undefined);
    assert.equal(position?.metadata.source, VesselSource.AISSTREAM);
    assert.equal(position?.lat, 33.749667);
    assert.equal(position?.lng, -118.20895);
    assert.equal(position?.speed, 10.6);
    assert.equal(position?.course, 123);
    // Mốc NGUỒN, không phải mốc bot.
    assert.equal(position?.receivedAt.toISOString(), "2026-08-16T12:09:42.123Z");
    assert.equal(position?.metadata.fetchedAt.toISOString(), NOW.toISOString());
    // Marine API không chuyển tiếp heading -> không được suy từ course.
    assert.equal(position?.heading, null);

    assert.equal(client.getStats().mappingSuccess, 1);
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §29 · ShipStaticData hợp lệ
// ---------------------------------------------------------------------------

test("§29 ShipStaticData -> normalizedData mang identity", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const emitted = once(client, MarineAisClientEvent.NORMALIZED_DATA);
    server.broadcast(STATIC_FRAME);
    const [event] = (await emitted) as [MarineAisNormalizedEvent];

    assert.equal(event.type, "ShipStaticData");
    const identity = event.result.identity;
    assert.equal(event.result.position, undefined);
    assert.equal(identity?.mmsi, "636018086");
    assert.equal(identity?.imo, "9074729");
    assert.equal(identity?.name, "AGIA DOXA");
    assert.equal(identity?.vesselTypeCode, 70);
    assert.equal(identity?.metadata.source, VesselSource.AISSTREAM);
    // Message 5 không mang mốc thời gian -> null, không mượn đồng hồ bot.
    assert.equal(identity?.metadata.sourceReceivedAt, null);
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §30–§32 · Frame hỏng KHÔNG được giết socket
// ---------------------------------------------------------------------------

test("§30 JSON hỏng -> đếm malformedJson, client vẫn sống", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const rejected = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast("not-json");
    const [event] = (await rejected) as [MarineAisRejection];

    assert.equal(event.reason, MarineAisFrameRejectReason.MALFORMED_JSON);
    assert.equal(client.getStats().malformedJson, 1);
    assert.equal(client.isActive(), true);

    // Vẫn xử lý được frame TỐT ngay sau đó -> socket không hề gãy.
    const ok = once(client, MarineAisClientEvent.NORMALIZED_DATA);
    server.broadcast(POSITION_FRAME);
    await ok;
    assert.equal(client.getStats().mappingSuccess, 1);
  } finally {
    await client.stop();
    await server.close();
  }
});

test("§31 JSON hợp lệ nhưng sai hình dạng -> contractMismatch, mapper không được gọi", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const rejected = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast("{}");
    const [event] = (await rejected) as [MarineAisRejection];

    assert.equal(event.reason, MarineAisFrameRejectReason.CONTRACT_MISMATCH);
    const stats = client.getStats();
    assert.equal(stats.contractMismatch, 1);
    // Không qua được cổng hình dạng -> mapper không chạy, không đếm gì thêm.
    assert.equal(stats.validMessages, 0);
    assert.equal(stats.mappingSuccess, 0);
    assert.equal(stats.mappingRejected, 0);
    assert.equal(client.isActive(), true);
  } finally {
    await client.stop();
    await server.close();
  }
});

test("§32 đúng hợp đồng nhưng MMSI rác -> mappingRejected, client vẫn sống", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const rejected = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast(BAD_MMSI_FRAME);
    const [event] = (await rejected) as [MarineAisRejection];

    assert.equal(event.reason, MarineAisRejectReason.INVALID_MMSI);
    const stats = client.getStats();
    assert.equal(stats.validMessages, 1, "qua được cổng hình dạng");
    assert.equal(stats.mappingRejected, 1);
    assert.equal(stats.contractMismatch, 0, "đây KHÔNG phải lỗi hợp đồng");
    assert.equal(client.isActive(), true);
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §33 · Reconnect
// ---------------------------------------------------------------------------

test("§33 server đóng socket -> client tự nối lại", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);
    assert.equal(server.accepted.length, 1);

    const reconnected = once(client, MarineAisClientEvent.CONNECTED);
    server.dropClients();
    await reconnected;

    await waitUntil(() => server.accepted.length === 2);
    assert.equal(client.getStats().reconnects, 1);
    assert.equal(client.getStats().connections, 2);
  } finally {
    await client.stop();
    await server.close();
  }
});

test("backoff có TRẦN: server không lên thì khoảng chờ dừng ở maxReconnectDelayMs", async () => {
  // Cổng đóng, không ai nghe -> mỗi lần thử đều hỏng ngay.
  const client = buildClient("ws://127.0.0.1:1/ais-stream", {
    initialReconnectDelayMs: 5,
    maxReconnectDelayMs: 10,
  });
  try {
    client.start();
    await waitUntil(() => client.getStats().reconnects >= 4);
    // Không nối được lần nào, nhưng cũng không quay tight loop.
    assert.equal(client.getStats().connections, 0);
  } finally {
    await client.stop();
  }
});

// ---------------------------------------------------------------------------
//  §34 · MỘT connection duy nhất
// ---------------------------------------------------------------------------

test("§34 gọi start() ba lần -> vẫn chỉ MỘT socket", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    client.start();
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    // Chờ thêm để chắc chắn không có socket thứ hai đến muộn.
    await delay(60);
    assert.equal(server.accepted.length, 1);
    assert.equal(client.getStats().connections, 1);

    // Đang OPEN mà gọi lại cũng không mở thêm.
    client.start();
    await delay(30);
    assert.equal(server.accepted.length, 1);
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §35 · stop() huỷ luôn reconnect đã lên lịch
// ---------------------------------------------------------------------------

test("§35 stop() huỷ reconnect đang chờ, không kết nối lại nữa", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url, {
    initialReconnectDelayMs: 40,
    maxReconnectDelayMs: 40,
  });
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    const disconnected = once(client, MarineAisClientEvent.DISCONNECTED);
    server.dropClients();
    await disconnected;
    assert.equal(client.getStats().reconnects, 1, "đã lên lịch nối lại");

    await client.stop();
    // Vượt hẳn khoảng chờ reconnect.
    await delay(120);

    assert.equal(server.accepted.length, 1, "không có connection mới sau stop()");
    assert.equal(client.isActive(), false);
  } finally {
    await server.close();
  }
});

test("stop() rồi mà chưa từng start() cũng không ném", async () => {
  const client = buildClient("ws://127.0.0.1:1/ais-stream");
  await client.stop();
  assert.equal(client.isActive(), false);
});

// ---------------------------------------------------------------------------
//  §36 · Cổng chặn URL
// ---------------------------------------------------------------------------

test("§36 URL trỏ thẳng tới AISStream -> ném NGAY lúc dựng client", () => {
  for (const url of [
    "wss://stream.aisstream.io/v0/stream",
    "ws://aisstream.io/v0/stream",
    "wss://STREAM.AISSTREAM.IO/v0/stream",
  ]) {
    assert.throws(() => buildClient(url), /nhà cung cấp AIS/, url);
  }
});

test("§36 URL sai giao thức / sai định dạng -> ném", () => {
  assert.throws(() => buildClient("https://marine.example.com/ais-stream"), /ws:\/\/ hoặc wss:\/\//);
  assert.throws(() => buildClient("khong-phai-url"), /không phải URL hợp lệ/);
});

test("§36 URL nội bộ hợp lệ -> dựng được, và KHÔNG tự kết nối", async () => {
  const server = await startFakeServer();
  try {
    const client = buildClient(server.url);
    assert.equal(client.isActive(), false);
    // Chưa gọi start() thì không frame nào, không socket nào.
    await delay(30);
    assert.equal(server.accepted.length, 0);
    await client.stop();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §37 · Bộ đếm
// ---------------------------------------------------------------------------

test("§37 getStats() đếm chính xác từng loại", async () => {
  const server = await startFakeServer();
  const client = buildClient(server.url);
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);
    await waitUntil(() => client.getStats().serverNotices === 1);

    const ok = once(client, MarineAisClientEvent.NORMALIZED_DATA);
    server.broadcast(POSITION_FRAME);
    await ok;

    const bad1 = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast("not-json");
    await bad1;

    const bad2 = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast("{}");
    await bad2;

    const bad3 = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
    server.broadcast(BAD_MMSI_FRAME);
    await bad3;

    const stats = client.getStats();
    // 1 chào + 1 tốt + 3 hỏng
    assert.equal(stats.receivedFrames, 5);
    assert.equal(stats.serverNotices, 1);
    assert.equal(stats.validMessages, 2, "1 position tốt + 1 position MMSI rác");
    assert.equal(stats.mappingSuccess, 1);
    assert.equal(stats.mappingRejected, 1);
    assert.equal(stats.malformedJson, 1);
    assert.equal(stats.contractMismatch, 1);
    assert.equal(stats.connections, 1);
    assert.equal(stats.reconnects, 0);
    assert.deepEqual(stats.rejectionsByReason, {
      MALFORMED_JSON: 1,
      CONTRACT_MISMATCH: 1,
      INVALID_MMSI: 1,
    });
  } finally {
    await client.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  Không giữ lịch sử · không log mỗi frame
// ---------------------------------------------------------------------------

test("client KHÔNG tích luỹ frame, và chỉ log lần ĐẦU của mỗi lý do", async () => {
  const server = await startFakeServer();
  const warnings: string[] = [];
  const client = buildClient(server.url, {
    logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
  });
  try {
    client.start();
    await once(client, MarineAisClientEvent.CONNECTED);

    for (let i = 0; i < 25; i += 1) {
      const rejected = once(client, MarineAisClientEvent.REJECTED_MESSAGE);
      server.broadcast("not-json");
      await rejected;
    }

    assert.equal(client.getStats().malformedJson, 25);
    assert.equal(warnings.length, 1, "25 frame hỏng nhưng chỉ log MỘT dòng");

    // Không có thuộc tính nào ôm mảng frame.
    const held = Object.values(client as unknown as Record<string, unknown>).filter(
      (value) => Array.isArray(value) && value.length > 0
    );
    assert.deepEqual(held, []);
  } finally {
    await client.stop();
    await server.close();
  }
});
