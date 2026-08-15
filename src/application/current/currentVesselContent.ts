// ============================================================================
//  APPLICATION · Vân tay nội dung canonical — để không update vô nghĩa
// ----------------------------------------------------------------------------
//  `ResolveCurrentVessel` LUÔN đặt `resolvedAt = now`. Nếu so cả object thì mỗi
//  lần resolve đều "khác" — chỉ vì đồng hồ chạy. Kho sẽ ghi lại y hệt mỗi phút
//  và `updatedAt` mất hết ý nghĩa.
//
//  Nên vân tay nội dung CỐ Ý BỎ `resolvedAt`.
//
//  Nhưng GIỮ toàn bộ provenance: `source`, `observationId`, `fetchedAt`,
//  `reason`, `rejected`. Đó KHÔNG phải nhiễu — `length = 179` do ShipFinder nói
//  khác với `length = 179` do ShipInfo nói. Đổi xuất xứ là đổi nội dung.
//
//  ⚠️ Hệ quả đã biết: crawl lại và ghi observation MỚI (cùng giá trị, id mới)
//  sẽ đổi `observationId`/`fetchedAt` -> UPDATED. Đúng: canonical đang trỏ tới
//  bản ghi khác. Muốn UNCHANGED thì phải KHÔNG có observation mới — đúng là
//  điều dedupe của P5 đảm bảo khi nguồn nói y hệt.
//
//  Dùng lại `stableSerialize` của P5: cùng luật chuẩn hoá, cùng SHA-256, không
//  thêm package.
// ============================================================================

import { createHash } from "node:crypto";
import { stableSerialize } from "../observations/observationFingerprint";
import { ResolvedCurrentVessel } from "../resolver/ResolvedCurrentVessel";

/**
 * SHA-256 của nội dung canonical, KHÔNG gồm `resolvedAt`.
 *
 * Hai `ResolvedCurrentVessel` cho cùng hash <=> chúng nói CÙNG một điều về con
 * tàu, với CÙNG xuất xứ.
 */
export function currentVesselContentHash(vessel: ResolvedCurrentVessel): string {
  const { resolvedAt: _resolvedAt, ...content } = vessel;
  return createHash("sha256").update(stableSerialize(content)).digest("hex");
}
