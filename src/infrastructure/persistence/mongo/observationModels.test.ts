// ============================================================================
//  TEST · Schema vessel_observations — chỉ đọc CẤU HÌNH, không cần Mongo chạy
// ----------------------------------------------------------------------------
//  `schema.indexes()` đọc được mà không cần connection, nên test này không đợi
//  TTL monitor và không đụng mạng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselObservationModel } from "./observationModels";

type IndexEntry = [Record<string, number | string>, Record<string, unknown>];

function indexes(): IndexEntry[] {
  return VesselObservationModel.schema.indexes() as IndexEntry[];
}

test("§16 có TTL index trên expiresAt với expireAfterSeconds = 0", () => {
  const ttl = indexes().find(([keys]) => Object.keys(keys).join() === "expiresAt");
  assert.notEqual(ttl, undefined, "thiếu index expiresAt");
  // 0 nghĩa là "hạn nằm ngay trong field", không phải "xoá sau 0 giây kể từ khi tạo".
  assert.equal(ttl?.[1].expireAfterSeconds, 0);
});

test("expiresAt KHÔNG required -> document cũ không có field vẫn sống mãi", () => {
  const path = VesselObservationModel.schema.path("expiresAt");
  assert.notEqual(path, undefined);
  assert.notEqual(path.isRequired, true);
});

test("§16 các index cũ KHÔNG bị đụng tới", () => {
  const signatures = indexes().map(([keys]) =>
    Object.entries(keys)
      .map(([field, direction]) => `${field}:${direction}`)
      .join(",")
  );
  for (const expected of [
    "mmsi:1,type:1,fetchedAt:-1",
    "imo:1,type:1,fetchedAt:-1",
    "source:1,fetchedAt:-1",
    "fingerprint:1,fetchedAt:-1",
  ]) {
    assert.ok(signatures.includes(expected), `mất index ${expected}`);
  }
});

test("§29 canonical_current_vessels KHÔNG có TTL index", async () => {
  // Ảnh chụp hiện tại là "hiện tại", không phải lịch sử — hết hạn theo thời gian
  // là việc của freshness policy ở phase map, không phải của TTL daemon.
  const { CurrentVesselModel } = await import("./currentVesselModel");
  const ttl = (CurrentVesselModel.schema.indexes() as IndexEntry[]).filter(
    ([, options]) => options.expireAfterSeconds !== undefined
  );
  assert.deepEqual(ttl, []);
});
