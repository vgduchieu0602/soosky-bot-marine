// ============================================================================
//  INFRASTRUCTURE · Mongoose model cho vessel_observations
// ----------------------------------------------------------------------------
//  COLLECTION RIÊNG, tách hẳn `vessels` / `latestpositions` / `vesselpositions`.
//  Lý do: ba collection kia là TRẠNG THÁI HIỆN TẠI (ghi đè theo mmsi), còn đây
//  là NHẬT KÝ lời khai (append-only, nhiều nguồn cùng tồn tại).
//
//  File riêng, KHÔNG thêm vào models.ts: giữ đường legacy không bị đụng tới
//  (models.ts đang được MongoVesselRepository và CLI reset-indexes dùng).
//
//  `timestamps: { updatedAt: false }` — observation BẤT BIẾN, không có gì để
//  cập nhật. Nguồn nói khác đi thì đó là bản ghi mới.
// ============================================================================

import { Schema, model } from "mongoose";

const validationIssueSchema = new Schema(
  {
    field: String,
    code: { type: String, required: true },
    message: String,
  },
  { _id: false }
);

const observationSchema = new Schema(
  {
    source: { type: String, required: true },
    type: { type: String, required: true },

    // Ít nhất một trong hai — kiểm ở domain (createObservationKey), không ở đây,
    // vì bản ghi định danh sai vẫn cần lưu được để debug parser.
    mmsi: { type: String, default: null },
    imo: { type: String, default: null },

    /** Nhóm canonical nguyên vẹn (VesselIdentity / VesselPositionReport / ...). */
    data: { type: Schema.Types.Mixed, required: true },

    fetchedAt: { type: Date, required: true },
    /** null khi upstream không cung cấp mốc thời gian đáng tin. */
    sourceReceivedAt: { type: Date, default: null },

    validationStatus: { type: String, required: true },
    validationErrors: { type: [validationIssueSchema], default: [] },

    parserVersion: String,

    /** Đã sanitize + cắt theo RawPayloadPolicy trước khi tới đây. */
    rawPayload: Schema.Types.Mixed,
    rawPayloadTruncated: { type: Boolean, default: false },

    /** SHA-256 của (source, type, khoá tàu, dữ liệu chuẩn hoá, sourceReceivedAt). */
    fingerprint: { type: String, required: true },

    /**
     * Mốc TTL, do `ObservationRetentionPolicy` quyết định ở tầng repository.
     *
     * ⚠️ KHÔNG `required`, và đó là cả cơ chế migration: document THIẾU field
     * này (bản ghi có trước AIS-5, hoặc nhóm được giữ vô thời hạn) không bao giờ
     * bị TTL monitor đụng tới. Không cần backfill hàng triệu dòng lúc khởi động.
     */
    expiresAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Truy vấn thật sự dùng, không hơn:
//   1-2) "cho tôi observation gần đây của tàu X, nhóm Y"  (mmsi hoặc imo)
//   3)   "nguồn Z gần đây trả về những gì"                 (soi sức khoẻ nguồn)
//   4)   dedupe: "vân tay này đã thấy trong cửa sổ chưa"   — không có index này
//        thì mỗi lần ghi là một lần quét toàn collection.
observationSchema.index({ mmsi: 1, type: 1, fetchedAt: -1 });
observationSchema.index({ imo: 1, type: 1, fetchedAt: -1 });
observationSchema.index({ source: 1, fetchedAt: -1 });
observationSchema.index({ fingerprint: 1, fetchedAt: -1 });

// TTL: Mongo xoá document khi `expiresAt` đã qua (`expireAfterSeconds: 0` nghĩa
// là "hạn nằm ngay trong field", không phải "xoá sau 0 giây kể từ khi tạo").
//
// ⚠️ Việc xoá KHÔNG tức thời: TTL monitor chạy nền ~60 giây một lượt và còn phụ
// thuộc tải. Nên tuyệt đối đừng coi TTL là hàng rào ĐÚNG ĐẮN — nó là hàng rào
// DUNG LƯỢNG. Luật freshness của resolver mới là thứ bảo vệ canonical.
observationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VesselObservationModel = model(
  "VesselObservation",
  observationSchema,
  "vessel_observations"
);
