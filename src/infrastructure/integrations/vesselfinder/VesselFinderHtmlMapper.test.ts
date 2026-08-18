// ============================================================================
//  TEST · VesselFinderHtmlMapper — giá trị BIÊN của AIS và ô trống của nguồn
// ----------------------------------------------------------------------------
//  HTML dựng tay, chỉ đủ các neo mà mapper thật đọc: #djson, bảng n3/v3, h1.
//  Không mạng, không fixture nặng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselFinderHtmlMapper } from "./VesselFinderHtmlMapper";

function html(djson: Record<string, unknown>, rows: Record<string, string> = {}): string {
  const table = Object.entries(rows)
    .map(([k, v]) => `<td class="n3">${k}</td><td class="v3">${v}</td>`)
    .join("");
  return (
    `<h1 class="title">TEST SHIP</h1>` +
    `<div id="djson" data-json='${JSON.stringify(djson)}'></div>` +
    `<table>${table}</table>`
  );
}

const KEYS = { "IMO / MMSI": "9074729 / 305803000" };

test("sog/cog = 0 được giữ nguyên (tàu neo/buộc bến)", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103, ship_sog: 0, ship_cog: 0 }, KEYS)
  );
  assert.equal(position.speedKn, 0);
  assert.equal(position.courseDeg, 0);
});

test("COG 360 là mã 'không có' của AIS -> null, không phải một hướng đi", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103, ship_cog: 360 }, KEYS)
  );
  assert.equal(position.courseDeg, null);
});

test("COG 359.9 vẫn hợp lệ", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103, ship_cog: 359.9 }, KEYS)
  );
  assert.equal(position.courseDeg, 359.9);
});

test("SOG vượt ngưỡng AIS (102.3) -> null", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103, ship_sog: 102.3 }, KEYS)
  );
  assert.equal(position.speedKn, null);
});

test("Navigation Status có chữ -> lấy được cả mã lẫn chữ", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103 }, { ...KEYS, "Navigation Status": "Moored" })
  );
  assert.equal(position.navStatusCode, 5);
  assert.equal(position.navStatusText, "Moored");
});

test("Navigation Status = 'Under way using engine' -> mã 0, KHÔNG bị coi là thiếu", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html(
      { ship_lat: 1, ship_lon: 103 },
      { ...KEYS, "Navigation Status": "Under way using engine" }
    )
  );
  assert.equal(position.navStatusCode, 0);
});

test("ô Navigation Status trống ('-') -> coi như VẮNG MẶT, không lưu nhãn giả", () => {
  for (const raw of ["-", "---", ""]) {
    const { position } = VesselFinderHtmlMapper.toDomain(
      html({ ship_lat: 1, ship_lon: 103 }, { ...KEYS, "Navigation Status": raw })
    );
    assert.equal(position.navStatusCode, null, `nhãn "${raw}"`);
    // "Unknown" là cách entity cũ biểu diễn "không có" -> canonical bỏ hẳn nhóm.
    assert.equal(position.navStatusText, "Unknown", `nhãn "${raw}"`);
  }
});

test("lrpd được giữ nguyên dạng thô cho provider suy mốc thời gian", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(
    html({ ship_lat: 1, ship_lon: 103, lrpd: " 5 min ago " }, KEYS)
  );
  assert.equal(position.positionTime, "5 min ago");
});
