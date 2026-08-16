// ============================================================================
//  TEST TÍCH HỢP · WS giả -> client (AIS-2) -> buffer (AIS-3) -> mẻ
// ----------------------------------------------------------------------------
//  Không mock client, không mock buffer. Chỉ giả lập server WebSocket ở
//  127.0.0.1 — đúng như test AIS-2. Không mạng ngoài, không Mongo.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { AisCoalescedBatch, AisCoalescingBuffer } from "./AisCoalescingBuffer";
import {
  AisIngestionEvent,
  MarineAisIngestionCoordinator,
} from "./MarineAisIngestionCoordinator";
import { MarineAisWebSocketClient } from "./MarineAisWebSocketClient";

const NOW = new Date("2026-08-16T12:10:00.000Z");
const SILENT_LOGGER = { info: () => {}, warn: () => {} };

function positionFrame(mmsi: number, hhmmss: string, lat: number): string {
  return JSON.stringify({
    type: "PositionReport",
    data: {
      mmsi,
      latlng: [lat, -118.2],
      sog: 10,
      cog: 120,
      timestamp: `2026-08-16 ${hhmmss} +0000 UTC`,
      navigationalStatus: 0,
    },
  });
}

function staticFrame(mmsi: number, name: string): string {
  return JSON.stringify({
    type: "ShipStaticData",
    data: { mmsi, imo: 9074729, type: 70, name },
  });
}

interface FakeServer {
  url: string;
  readonly accepted: WebSocket[];
  broadcast(raw: string): void;
  close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ais-stream" });
  await once(server, "listening");
  const accepted: WebSocket[] = [];
  server.on("connection", (socket) => {
    accepted.push(socket);
    socket.on("error", () => {});
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
    async close() {
      for (const socket of accepted) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil hết giờ");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
//  §38 · Đường ống thật
// ---------------------------------------------------------------------------

test("§38 frame WS -> mapper -> buffer -> mẻ đã gộp", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({
    url: server.url,
    now: () => NOW,
    logger: SILENT_LOGGER,
  });
  const buffer = new AisCoalescingBuffer({ maxVessels: 100, batchSize: 500, now: () => NOW });
  // Cửa sổ dài -> chỉ `flushNow()` mới rút, test không phụ thuộc đồng hồ.
  const coordinator = new MarineAisIngestionCoordinator({
    client,
    buffer,
    windowMs: 60_000,
  });

  const batches: AisCoalescedBatch[] = [];
  coordinator.on(AisIngestionEvent.BATCH, (batch: AisCoalescedBatch) => batches.push(batch));

  try {
    coordinator.start();
    await once(client, "connected");

    // Cùng một tàu phát 3 vị trí + 1 static; tàu thứ hai phát 1 vị trí.
    server.broadcast(positionFrame(636018086, "12:00:01", 1));
    server.broadcast(positionFrame(636018086, "12:00:03", 2));
    server.broadcast(staticFrame(636018086, "AGIA DOXA"));
    server.broadcast(positionFrame(636018086, "12:00:06", 3));
    server.broadcast(positionFrame(305803000, "12:00:07", 50));

    await waitUntil(() => buffer.getStats().acceptedEvents === 5);
    assert.equal(batches.length, 0, "chưa tới chu kỳ thì chưa có mẻ nào");

    coordinator.flushNow();

    assert.equal(batches.length, 1);
    const entries = batches[0].entries;
    assert.equal(entries.length, 2, "5 frame -> 2 tàu");

    const first = entries.find((entry) => entry.mmsi === "636018086");
    assert.equal(first?.position?.lat, 3, "chỉ vị trí mới nhất");
    assert.equal(first?.identity?.name, "AGIA DOXA", "identity không bị vị trí đè");
    assert.equal(first?.position?.metadata.source, VesselSource.AISSTREAM);

    const second = entries.find((entry) => entry.mmsi === "305803000");
    assert.equal(second?.position?.lat, 50);
    assert.equal(second?.identity, undefined);

    assert.equal(buffer.getStats().positionReplaced, 2);
  } finally {
    await coordinator.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  §37 · Timer (chờ mili-giây, không phải giây)
// ---------------------------------------------------------------------------

test("§37 hết cửa sổ -> coordinator tự rút", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({
    url: server.url,
    now: () => NOW,
    logger: SILENT_LOGGER,
  });
  const buffer = new AisCoalescingBuffer({ maxVessels: 100, batchSize: 500, now: () => NOW });
  const coordinator = new MarineAisIngestionCoordinator({ client, buffer, windowMs: 20 });

  const batches: AisCoalescedBatch[] = [];
  coordinator.on(AisIngestionEvent.BATCH, (batch: AisCoalescedBatch) => batches.push(batch));

  try {
    coordinator.start();
    await once(client, "connected");
    server.broadcast(positionFrame(636018086, "12:00:01", 1));

    await waitUntil(() => batches.length >= 1);
    assert.equal(batches[0].entries[0].mmsi, "636018086");
  } finally {
    await coordinator.stop();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
//  Vòng đời
// ---------------------------------------------------------------------------

test("stop() ngắt nguồn TRƯỚC rồi rút nốt, không bỏ sót phần cuối", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({
    url: server.url,
    now: () => NOW,
    logger: SILENT_LOGGER,
  });
  const buffer = new AisCoalescingBuffer({ maxVessels: 100, batchSize: 500, now: () => NOW });
  const coordinator = new MarineAisIngestionCoordinator({ client, buffer, windowMs: 60_000 });

  const batches: AisCoalescedBatch[] = [];
  coordinator.on(AisIngestionEvent.BATCH, (batch: AisCoalescedBatch) => batches.push(batch));

  try {
    coordinator.start();
    await once(client, "connected");
    server.broadcast(positionFrame(636018086, "12:00:01", 1));
    await waitUntil(() => buffer.pendingCount() === 1);

    await coordinator.stop();

    assert.equal(batches.length, 1, "phần còn lại được rút lúc dừng");
    assert.equal(buffer.pendingCount(), 0);
    assert.equal(coordinator.isRunning(), false);
    assert.equal(client.isActive(), false);
  } finally {
    await server.close();
  }
});

test("start() nhiều lần vẫn chỉ một listener, một timer, một socket", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({
    url: server.url,
    now: () => NOW,
    logger: SILENT_LOGGER,
  });
  const buffer = new AisCoalescingBuffer({ maxVessels: 100, batchSize: 500, now: () => NOW });
  const coordinator = new MarineAisIngestionCoordinator({ client, buffer, windowMs: 60_000 });

  try {
    coordinator.start();
    coordinator.start();
    coordinator.start();
    await once(client, "connected");

    server.broadcast(positionFrame(636018086, "12:00:01", 1));
    await waitUntil(() => buffer.getStats().acceptedEvents === 1);

    // Một listener -> một event = một lần accept, không phải ba.
    assert.equal(buffer.getStats().acceptedEvents, 1);
    assert.equal(server.accepted.length, 1);
  } finally {
    await coordinator.stop();
    await server.close();
  }
});

test("stop() rồi thì frame tới sau KHÔNG vào buffer nữa", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({
    url: server.url,
    now: () => NOW,
    logger: SILENT_LOGGER,
  });
  const buffer = new AisCoalescingBuffer({ maxVessels: 100, batchSize: 500, now: () => NOW });
  const coordinator = new MarineAisIngestionCoordinator({ client, buffer, windowMs: 60_000 });

  try {
    coordinator.start();
    await once(client, "connected");
    await coordinator.stop();

    server.broadcast(positionFrame(636018086, "12:00:01", 1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(buffer.getStats().acceptedEvents, 0);
  } finally {
    await server.close();
  }
});

test("windowMs vô lý -> ném NGAY lúc dựng", async () => {
  const server = await startFakeServer();
  const client = new MarineAisWebSocketClient({ url: server.url, logger: SILENT_LOGGER });
  const buffer = new AisCoalescingBuffer({ maxVessels: 10, batchSize: 10 });
  try {
    assert.throws(
      () => new MarineAisIngestionCoordinator({ client, buffer, windowMs: 0 }),
      /windowMs/
    );
  } finally {
    await server.close();
  }
});
