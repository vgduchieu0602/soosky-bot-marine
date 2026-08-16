// ============================================================================
//  INFRASTRUCTURE · Mongoose model cho canonical_current_vessels
// ----------------------------------------------------------------------------
//  COLLECTION RIÊNG. Không đụng `vessels` / `latestpositions` / `vesselpositions`
//  (legacy, đang chạy production) và cũng không đụng `vessel_observations`
//  (nhật ký append-only).
//
//  Ba kho, ba ngữ nghĩa:
//      vessels/latestpositions   legacy, ghi đè theo last-write-wins, KHÔNG xuất xứ
//      vessel_observations       "nguồn X nói Y lúc T", bất biến, nhiều nguồn cùng tồn tại
//      canonical_current_vessels "ảnh hợp nhất tốt nhất", upsert, CÓ xuất xứ từng field
//
//  File riêng, KHÔNG thêm vào models.ts — giữ đường legacy không bị đụng.
//
//  `timestamps: true` — ở đây createdAt/updatedAt CÓ nghĩa (khác observation
//  bất biến). Đây là metadata PERSISTENCE, tuyệt đối không lẫn với `resolvedAt`
//  (lúc chạy resolve), `fetchedAt` (lúc bot lấy được) hay `observedAt` (mốc
//  nguồn khai).
// ============================================================================

import { Schema, model } from "mongoose";

/** Ứng viên bị loại — giữ để trả lời "vì sao KHÔNG chọn nguồn kia". */
const rejectedCandidateSchema = new Schema(
  {
    source: { type: String, required: true },
    observationId: String,
    /** Mã đóng của `RejectionReason`. KHÔNG lưu câu chữ cho người đọc. */
    reason: { type: String, required: true },
  },
  { _id: false }
);

/**
 * Một field canonical KÈM xuất xứ. Dùng lại cho cả identity/particulars/voyage.
 *
 * `value` là Mixed vì kiểu thật khác nhau theo field (string / number / Date).
 * BSON giữ nguyên kiểu -> `eta` và `lastPortDepartureAt` đọc lại vẫn là `Date`,
 * không phải chuỗi.
 */
const resolvedFieldSchema = new Schema(
  {
    value: { type: Schema.Types.Mixed, required: true },
    source: { type: String, required: true },
    observationId: String,
    /** Mốc NGUỒN khai. Nhóm tĩnh luôn null. */
    observedAt: { type: Date, default: null },
    /** Lúc bot lấy được. Luôn có. */
    fetchedAt: { type: Date, required: true },
    /** Mã đóng của `ResolutionReason`. */
    reason: { type: String, required: true },
    rejected: { type: [rejectedCandidateSchema], default: [] },
  },
  { _id: false }
);

/** `null` = không nguồn nào cho field này. Khác hẳn "có nhưng chưa phân xử". */
const field = () => ({ type: resolvedFieldSchema, default: null });

const identitySchema = new Schema(
  {
    mmsi: { type: String, required: true },
    imo: field(),
    name: field(),
    callsign: field(),
    vesselType: field(),
    vesselTypeCode: field(),
    // Hai nửa của cờ phân xử RIÊNG -> có thể đến từ hai nguồn khác nhau.
    flagCode: field(),
    flagName: field(),
  },
  { _id: false }
);

const positionSchema = new Schema(
  {
    /**
     * NGUYÊN KHỐI: `VesselPositionReport` của ĐÚNG MỘT observation.
     * Mixed vì đây là nhóm canonical nguyên vẹn — cùng cách `vessel_observations.data`
     * lưu. TUYỆT ĐỐI không tách ra rồi trộn field từ nguồn khác vào
     * (RESOLVER_POLICY.md §D.0).
     */
    position: { type: Schema.Types.Mixed, required: true },
    source: { type: String, required: true },
    observationId: String,
    observedAt: { type: Date, default: null },
    fetchedAt: { type: Date, required: true },
    /** Bậc độ tươi lúc phân xử: LIVE / RECENT / STALE / EXPIRED / NO_SOURCE_TIME. */
    freshness: { type: String, required: true },
    reason: { type: String, required: true },
    rejected: { type: [rejectedCandidateSchema], default: [] },
  },
  { _id: false }
);

const particularsSchema = new Schema(
  {
    mmsi: { type: String, required: true },
    length: field(),
    beam: field(),
    draught: field(),
    grossTonnage: field(),
    deadweight: field(),
    builtYear: field(),
  },
  { _id: false }
);

const voyageSchema = new Schema(
  {
    mmsi: { type: String, required: true },
    destination: field(),
    eta: field(),
    currentPort: field(),
    nextPort: field(),
    lastPort: field(),
    lastPortDepartureAt: field(),
  },
  { _id: false }
);

const currentVesselSchema = new Schema(
  {
    // Khoá canonical. Ít nhất một trong hai có giá trị — kiểm ở repository.
    mmsi: { type: String, default: null },
    imo: { type: String, default: null },

    // Bốn nhóm độc lập. `null` = chưa phân xử được nhóm đó, KHÔNG phải lỗi:
    // tàu mới chỉ có identity mà chưa có vị trí vẫn là dữ liệu dùng được.
    identity: { type: identitySchema, default: null },
    position: { type: positionSchema, default: null },
    particulars: { type: particularsSchema, default: null },
    voyage: { type: voyageSchema, default: null },

    /** Thời điểm CHẠY resolve. Không phải max(fetchedAt), không phải updatedAt. */
    resolvedAt: { type: Date, required: true },

    /** SHA-256 nội dung canonical, KHÔNG gồm `resolvedAt` -> dùng để bỏ update vô nghĩa. */
    contentHash: { type: String, required: true },
  },
  { timestamps: true }
);

// ⚠️ `partialFilterExpression` phải là `$type: "string"`, KHÔNG phải `$exists`.
// `mmsi: null` vẫn thoả `$exists: true`, nên unique + $exists sẽ chỉ cho phép
// ĐÚNG MỘT document thiếu MMSI trong toàn collection — mọi tàu chỉ biết IMO thứ
// hai trở đi sẽ bị từ chối ghi.
currentVesselSchema.index(
  { mmsi: 1 },
  { unique: true, partialFilterExpression: { mmsi: { $type: "string" } } }
);
currentVesselSchema.index(
  { imo: 1 },
  { unique: true, partialFilterExpression: { imo: { $type: "string" } } }
);

// Chỉ hai index trên. KHÔNG thêm index suy đoán (geo, freshness, source...) khi
// chưa có truy vấn nào cần — index thừa làm chậm mọi lần ghi.

export const CurrentVesselModel = model(
  "CanonicalCurrentVessel",
  currentVesselSchema,
  "canonical_current_vessels"
);
