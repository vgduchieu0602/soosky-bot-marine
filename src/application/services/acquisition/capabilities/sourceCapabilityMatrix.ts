// ============================================================================
//  APPLICATION · SOURCE CAPABILITY MATRIX
// ----------------------------------------------------------------------------
//  Bảng "nguồn nào cấp được field nào". Đây là CẤU HÌNH ĐÓNG BĂNG, không phải
//  provider implementation: không nguồn nào ở đây có adapter, không request
//  mạng nào được thực hiện để dựng bảng này.
//
//  LUẬT ĐÁNH TRẠNG THÁI (đọc kỹ trước khi sửa):
//    CONFIRMED   chỉ khi có bằng chứng — code trong repo đã bóc được field,
//                hoặc đặc tả nguồn mà dự án đã xác nhận.
//    CANDIDATE   nguồn có thể cấp nhưng CHƯA audit/POC trong dự án.
//    UNSUPPORTED nguồn không phù hợp / có bằng chứng không cấp.
//
//  Bằng chứng cho VESSELFINDER lấy từ docs/CURRENT_DATA_FLOW.md §2 — field nào
//  mapper hiện KHÔNG bóc thì KHÔNG được CONFIRMED, kể cả khi Mongo schema có
//  cột đó.
// ============================================================================

import { VesselField } from "../../../../domain/enums/VesselField";
import { VesselSource } from "../../../../domain/enums/VesselSource";
import {
  FieldSupportStatus,
  SourceCapability,
  SourceCostType,
  buildFieldSupport,
  defineSourceCapability,
} from "./SourceCapability";

const { CONFIRMED, CANDIDATE, UNSUPPORTED } = FieldSupportStatus;

const NO_OPERATIONS = {
  searchByName: false,
  searchByMmsi: false,
  searchByImo: false,
  position: false,
  particulars: false,
  voyage: false,
  areaScan: false,
} as const;

// ---------------------------------------------------------------------------
//  AISSTREAM — hạ tầng Marine đã vận hành, bot CHƯA nối
// ---------------------------------------------------------------------------
//  ⚠️ Bằng chứng ĐÃ ĐỔI ở phase AIS-1. Trước đây trạng thái lấy theo ĐẶC TẢ AIS
//  (message 1/2/3 + message 5). Nhưng bot không nói chuyện với AISStream.io —
//  nó sẽ đọc qua WebSocket của Soosky-marine-api, và production RÚT GỌN payload
//  trước khi phát (`AisWebSocketManager._dataTransform`):
//
//      PositionReport  -> mmsi · latlng · sog · cog · timestamp · navigationalStatus
//      ShipStaticData  -> mmsi · imo · type · name
//
//  Nên CONFIRMED nay chỉ còn ĐÚNG 10 field đó. `callsign`, `length`, `beam`,
//  `draught`, `destination`, `eta`, `heading` CÓ trong message gốc nhưng KHÔNG
//  đi qua được đường truyền -> CANDIDATE ("nguồn có, đường ta dùng chưa lấy
//  được"), cùng nghĩa với `eta` của ShipFinder.
//  Xem docs/AIS_CANONICAL_INGESTION.md §3 và §7.
const AISSTREAM = defineSourceCapability({
  source: VesselSource.AISSTREAM,
  operations: {
    searchByName: false,
    searchByMmsi: true,
    searchByImo: false, // AIS đánh địa chỉ theo MMSI; IMO chỉ là payload của msg 5
    position: true,
    // Đường truyền Marine chỉ mang được hai nhóm: POSITION và IDENTITY. Mapper
    // AIS-1 KHÔNG phát ra nhóm Particulars/Voyage nào, nên khai true ở đây là
    // hứa một thứ không tồn tại.
    particulars: false,
    voyage: false,
    areaScan: true, // subscription của Marine đã đặt bbox toàn cầu
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    // --- CONFIRMED: có trong payload production, mapper AIS-1 bóc được ---
    [VesselField.MMSI]: CONFIRMED,
    [VesselField.LAT]: CONFIRMED,
    [VesselField.LNG]: CONFIRMED,
    [VesselField.SPEED]: CONFIRMED,
    [VesselField.COURSE]: CONFIRMED,
    [VesselField.NAV_STATUS]: CONFIRMED,
    [VesselField.POSITION_RECEIVED_AT]: CONFIRMED, // MetaData.time_utc
    [VesselField.IMO]: CONFIRMED,
    [VesselField.NAME]: CONFIRMED,
    [VesselField.VESSEL_TYPE_CODE]: CONFIRMED,

    // --- CANDIDATE: AIS có, đường truyền Marine KHÔNG chuyển tiếp ---
    [VesselField.HEADING]: CANDIDATE, // TrueHeading của msg 1/2/3
    [VesselField.CALLSIGN]: CANDIDATE, // CallSign của msg 5
    [VesselField.LENGTH]: CANDIDATE, // Dimension của msg 5
    [VesselField.BEAM]: CANDIDATE,
    [VesselField.DRAUGHT]: CANDIDATE, // MaximumStaticDraught của msg 5
    [VesselField.DESTINATION]: CANDIDATE,
    [VesselField.ETA]: CANDIDATE,

    // --- CANDIDATE: suy diễn, không phải field gốc ---
    [VesselField.VESSEL_TYPE]: CANDIDATE, // AIS cho MÃ; nhãn chữ phải tự map
    [VesselField.FLAG]: CANDIDATE, // suy từ MID (3 số đầu MMSI), cần bảng tra
    // GROSS_TONNAGE / DEADWEIGHT / BUILT_YEAR / mọi field cảng: AIS không mang.
  }),
  costType: SourceCostType.EXISTING_STREAM,
  enabled: false,
  defaultPriority: 10,
  notes: [
    "Marine đã sở hữu và vận hành kết nối AISStream. Bot KHÔNG mở connection thứ hai tới stream.aisstream.io.",
    "enabled=false là quyết định vận hành (tránh 2 connection), không phải giới hạn kỹ thuật. costType=EXISTING_STREAM khiến FreeSourceSelector loại ngay ở cổng chi phí.",
    "CONFIRMED = 10 field mà `AisWebSocketManager._dataTransform` thực sự phát. KHÔNG confirm theo đặc tả AIS: đặc tả không phải thứ chạy trong production.",
    "heading/callsign/length/beam/draught/destination/eta là CANDIDATE: có trong AIS message gốc nhưng Marine API không chuyển tiếp. Nâng lên CONFIRMED chỉ khi đường truyền đổi.",
    "GT/DWT/năm đóng UNSUPPORTED: không AIS message nào mang các trường này.",
    "Mọi field cảng UNSUPPORTED: AIS không phát sự kiện cập cảng/rời cảng.",
  ],
});

// ---------------------------------------------------------------------------
//  VESSELFINDER — nguồn DUY NHẤT đã có implementation thật trong repo
// ---------------------------------------------------------------------------
//  Hai đường lấy dữ liệu, capability là HỢP của cả hai:
//    • mp2 binary (VesselFinderMapSource): mmsi, name, lat, lng — toạ độ chính xác
//    • HTML details (VesselFinderHtmlSource + VesselFinderHtmlMapper): lý lịch
//      + sog/cog, nhưng lat/lng bị làm tròn (latLonApproximate=true)
const VESSELFINDER = defineSourceCapability({
  source: VesselSource.VESSELFINDER,
  operations: {
    searchByName: false, // repo không có đường tra theo tên
    searchByMmsi: true,
    searchByImo: true, // trang details tự redirect IMO <-> MMSI
    position: true,
    particulars: true,
    voyage: false, // mapper hiện không bóc destination/eta
    areaScan: true, // /api/pub/mp2
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    // --- CONFIRMED: mapper/decoder trong repo bóc được, có test hoặc có đường chạy thật ---
    [VesselField.MMSI]: CONFIRMED, // mp2 + bảng "IMO / MMSI"
    [VesselField.NAME]: CONFIRMED, // mp2 + h1.title
    [VesselField.LAT]: CONFIRMED, // mp2 (chính xác) + #djson (làm tròn)
    [VesselField.LNG]: CONFIRMED,
    [VesselField.IMO]: CONFIRMED, // bảng "IMO / MMSI"
    [VesselField.CALLSIGN]: CONFIRMED, // bảng "Callsign"
    [VesselField.VESSEL_TYPE]: CONFIRMED, // bảng "AIS Type"
    [VesselField.FLAG]: CONFIRMED, // bảng "AIS Flag" -> flag.name (flag.code chưa có)
    [VesselField.LENGTH]: CONFIRMED, // bảng "Length / Beam"
    [VesselField.BEAM]: CONFIRMED,
    [VesselField.DRAUGHT]: CONFIRMED, // bảng "Current draught"
    [VesselField.SPEED]: CONFIRMED, // #djson.ship_sog
    [VesselField.COURSE]: CONFIRMED, // #djson.ship_cog
    [VesselField.NAV_STATUS]: CONFIRMED, // bảng "Navigation Status" (CHỈ text, không mã)

    // --- CANDIDATE: có dấu vết nhưng mapper hiện KHÔNG bóc -> chưa được confirm ---
    [VesselField.VESSEL_TYPE_CODE]: CANDIDATE, // #djson.ship_type khai báo nhưng không đọc
    [VesselField.POSITION_RECEIVED_AT]: CANDIDATE, // #djson.lrpd là chuỗi TƯƠNG ĐỐI ("0 min ago")
    [VesselField.GROSS_TONNAGE]: CANDIDATE, // Mongo có cột, mapper không bóc
    [VesselField.DEADWEIGHT]: CANDIDATE,
    [VesselField.BUILT_YEAR]: CANDIDATE,
    [VesselField.DESTINATION]: CANDIDATE,
    [VesselField.ETA]: CANDIDATE,
    [VesselField.HEADING]: CANDIDATE, // chưa audit payload đầy đủ của #djson
    // --- UNSUPPORTED: không có dấu vết nào trong repo cho lịch cảng ---
  }),
  costType: SourceCostType.FREE,
  enabled: true,
  defaultPriority: 20,
  notes: [
    "enabled=true CHỈ phản ánh việc legacy crawler đang chạy production (ScanArea/EnrichVesselTypes/CrawlFleetPositions). Nó KHÔNG có nghĩa nguồn này mặc định được phép dùng trong multi-source resolver mới — resolver phải tự quyết theo policy riêng.",
    "Nguồn duy nhất đã có adapter thật: VesselFinderMapSource (mp2) + VesselFinderHtmlSource (HTML).",
    "LAT/LNG từ HTML bị làm tròn (~111km) -> latLngApproximate=true; từ mp2 thì chính xác.",
    "NAV_STATUS chỉ CONFIRMED phần text; navStatusCode chưa nguồn nào ghi.",
    "GROSS_TONNAGE/DEADWEIGHT/BUILT_YEAR/DESTINATION/ETA là CANDIDATE vì Mongo schema có cột nhưng VesselFinderHtmlMapper KHÔNG bóc (CURRENT_DATA_FLOW.md §2.3).",
    "P2 không mở rộng crawler — nâng CANDIDATE lên CONFIRMED là việc của phase sau.",
  ],
});

// ---------------------------------------------------------------------------
//  SHIPINFO — nguồn thứ HAI có implementation thật (shipinfo.net)
// ---------------------------------------------------------------------------
//  CONFIRMED ở đây đã đi TRỌN đường: audit P6.1 -> raw parser P6.2 -> canonical
//  mapper + provider P6.3 -> runtime P4 + observation P5, và POC live P6.4 đã
//  ghi observation thật vào `vessel_observations`.
//  Xem docs/sources/SHIPINFO_POC.md.
const SHIPINFO = defineSourceCapability({
  source: VesselSource.SHIPINFO,
  operations: {
    // Endpoint tìm theo tên nằm dưới /api/ mà robots.txt cấm -> KHÔNG hỗ trợ.
    searchByName: false,
    searchByMmsi: true,
    searchByImo: true,
    position: true,
    particulars: true,
    voyage: false,
    areaScan: false,
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    // --- CONFIRMED: đã xuất hiện trong observation THẬT ---
    [VesselField.MMSI]: CONFIRMED,
    [VesselField.IMO]: CONFIRMED,
    [VesselField.NAME]: CONFIRMED,
    [VesselField.CALLSIGN]: CONFIRMED,
    [VesselField.VESSEL_TYPE]: CONFIRMED,
    [VesselField.FLAG]: CONFIRMED, // cho CẢ mã ("LR") lẫn tên ("Liberia")
    [VesselField.BUILT_YEAR]: CONFIRMED,
    [VesselField.DEADWEIGHT]: CONFIRMED,
    [VesselField.LAT]: CONFIRMED,
    [VesselField.LNG]: CONFIRMED,
    [VesselField.SPEED]: CONFIRMED,
    [VesselField.COURSE]: CONFIRMED, // sentinel "-1" bị mapper loại thành null
    [VesselField.POSITION_RECEIVED_AT]: CONFIRMED, // mốc UTC suy từ updated_utc

    // --- UNSUPPORTED: BẰNG CHỨNG VẮNG MẶT, không phải "chưa audit" ---
    // LENGTH/BEAM  : nguồn đảo KHÔNG NHẤT QUÁN giữa các tàu -> mapper CỐ Ý
    //                không map. Dữ liệu sai tệ hơn không có dữ liệu.
    // HEADING/DRAUGHT/DESTINATION/ETA : khoá tồn tại nhưng null ở 0/1073 điểm.
    // GROSS_TONNAGE/NAV_STATUS        : nguồn không có khoá nào.
    // VESSEL_TYPE_CODE                : chỉ có nhãn chữ, không có mã AIS.
  }),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: 45,
  notes: [
    "Có provider thật (ShipInfoProvider), đã đăng ký trong ProviderRegistry, mọi request đi qua crawl runtime P4.",
    "enabled=false: mới chỉ có POC gọi TAY (`npm run shipinfo:poc`), CHƯA có ingestion tự động. Bật lên là một quyết định riêng.",
    "⚠️ Vị trí bản free TRỄ ~14 GIỜ có chủ ý (fresh_locked). Không dùng làm nguồn vị trí thời gian thực; merge policy phải xếp sau nguồn tươi hơn theo sourceReceivedAt.",
    "LENGTH/BEAM là UNSUPPORTED do dữ liệu nguồn ĐẢO không nhất quán, KHÔNG phải do thiếu dữ liệu.",
    "Không dùng bất kỳ endpoint /api/ nào (robots.txt cấm) -> không có tìm theo tên.",
    "Giá trị riêng so với VesselFinder: mã cờ quốc gia, và lịch sử track ~270 điểm/tàu (chưa khai thác).",
  ],
});

// ---------------------------------------------------------------------------
//  SHIPFINDER — nguồn thứ BA có implementation thật (www.shipfinder.com)
// ---------------------------------------------------------------------------
//  CONFIRMED ở đây đã đi TRỌN đường: audit P7.1 -> raw parser P7.2 -> canonical
//  mapper + provider P7.3 -> runtime P4 + observation P5, và POC live P7.4 đã
//  ghi observation thật vào `vessel_observations`.
//  Xem docs/sources/SHIPFINDER_POC.md.
//
//  Điểm mạnh riêng: vị trí TƯƠI THEO PHÚT (POC đo 6.1 phút) trong khi ShipInfo
//  bị khoá trễ ~14 giờ; và là nguồn duy nhất cho heading + navStatus + draught.
const SHIPFINDER = defineSourceCapability({
  source: VesselSource.SHIPFINDER,
  operations: {
    // Tìm theo tên chỉ có qua API ký chữ ký -> không hỗ trợ.
    searchByName: false,
    searchByMmsi: true,
    // `/ship/detail/imo/{imo}` trả 404; không có đường tra theo IMO.
    searchByImo: false,
    position: true,
    particulars: true,
    voyage: true,
    areaScan: false,
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    // --- CONFIRMED: đã xuất hiện trong observation THẬT ---
    [VesselField.MMSI]: CONFIRMED,
    [VesselField.IMO]: CONFIRMED,
    [VesselField.NAME]: CONFIRMED,
    [VesselField.CALLSIGN]: CONFIRMED,
    [VesselField.VESSEL_TYPE]: CONFIRMED,
    [VesselField.FLAG]: CONFIRMED, // mã ISO3 ("LBR"), khác ISO2 của ShipInfo
    [VesselField.LAT]: CONFIRMED, // DDM -> decimal degrees
    [VesselField.LNG]: CONFIRMED,
    [VesselField.SPEED]: CONFIRMED,
    [VesselField.COURSE]: CONFIRMED,
    [VesselField.HEADING]: CONFIRMED, // ShipInfo: 0/1073 điểm
    [VesselField.NAV_STATUS]: CONFIRMED, // chỉ text; ShipInfo không có khoá
    [VesselField.POSITION_RECEIVED_AT]: CONFIRMED, // ⚠️ phụ thuộc giả định múi giờ
    [VesselField.LENGTH]: CONFIRMED,
    [VesselField.BEAM]: CONFIRMED,
    [VesselField.DRAUGHT]: CONFIRMED, // ShipInfo: 0/1073 điểm
    [VesselField.DESTINATION]: CONFIRMED,

    // --- CANDIDATE: nguồn CÓ nhưng đường ta dùng chưa lấy được ---
    // ETA: trang cho "07-29 07:01" — THIẾU NĂM. Canonical `eta` là Date nên
    //   mapper cố ý KHÔNG map; bịa năm sẽ sai ở ranh giới năm mới.
    [VesselField.ETA]: CANDIDATE,
    // GT/DWT/năm đóng: nằm sau `/ship/GetIHSData` — API ký chữ ký, ta không đụng.
    [VesselField.GROSS_TONNAGE]: CANDIDATE,
    [VesselField.DEADWEIGHT]: CANDIDATE,
    [VesselField.BUILT_YEAR]: CANDIDATE,
    // Cảng: mục Port Call đòi đăng nhập, Ship Event là tính năng trả tiền.
    [VesselField.CURRENT_PORT]: CANDIDATE,
    [VesselField.NEXT_PORT]: CANDIDATE,
    [VesselField.LAST_PORT]: CANDIDATE,

    // --- UNSUPPORTED (mặc định): VESSEL_TYPE_CODE (chỉ có nhãn chữ) và các
    //     mốc thời gian cảng (không có bằng chứng nào).
  }),
  costType: SourceCostType.FREE,
  enabled: false,
  // ⚠️ GIỮ NGUYÊN 55 dù vị trí tươi hơn ShipInfo (45). Đổi thứ tự ưu tiên chính
  // là mã hoá "ShipFinder thắng ShipInfo" — đó là việc của resolver, CHƯA CÓ.
  defaultPriority: 55,
  notes: [
    "Có provider thật (ShipFinderProvider), đã đăng ký trong ProviderRegistry, mọi request đi qua crawl runtime P4.",
    "enabled=false: mới chỉ có POC gọi TAY (`npm run shipfinder:poc`), CHƯA có ingestion tự động.",
    "⚠️ POSITION_RECEIVED_AT phụ thuộc GIẢ ĐỊNH VẬN HÀNH về múi giờ: nguồn KHÔNG khai báo timezone, P7.1 chỉ suy luận UTC+8. Không đặt SHIPFINDER_SOURCE_UTC_OFFSET_MINUTES thì provider KHÔNG phát nhóm position.",
    "Chỉ tra được bằng MMSI. Không tìm theo tên, không quét vùng (endpoint đều bị ký chữ ký hoặc không tồn tại).",
    "Không dùng bất kỳ endpoint /Ship/* nào (đòi header chữ ký `s` + `t`).",
    "Giá trị riêng so với ShipInfo: vị trí tươi theo PHÚT (POC: 6.1 phút vs ~14 giờ), cộng heading + navStatus + draught.",
  ],
});

// ---------------------------------------------------------------------------
//  BOATNERD — thiên về vị trí, phạm vi khu vực (Great Lakes). Chưa implementation.
// ---------------------------------------------------------------------------
const BOATNERD = defineSourceCapability({
  source: VesselSource.BOATNERD,
  operations: {
    searchByName: true,
    searchByMmsi: true,
    searchByImo: false,
    position: true,
    particulars: true,
    voyage: false,
    areaScan: false,
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    [VesselField.MMSI]: CANDIDATE,
    [VesselField.NAME]: CANDIDATE,
    [VesselField.LAT]: CANDIDATE,
    [VesselField.LNG]: CANDIDATE,
    [VesselField.SPEED]: CANDIDATE,
    [VesselField.COURSE]: CANDIDATE,
    [VesselField.HEADING]: CANDIDATE,
    [VesselField.POSITION_RECEIVED_AT]: CANDIDATE,
    [VesselField.VESSEL_TYPE]: CANDIDATE,
    [VesselField.LENGTH]: CANDIDATE,
    [VesselField.BEAM]: CANDIDATE,
    [VesselField.BUILT_YEAR]: CANDIDATE,
    [VesselField.GROSS_TONNAGE]: CANDIDATE,
    [VesselField.DEADWEIGHT]: CANDIDATE,
  }),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: 60,
  notes: [
    "Chưa có implementation. Position-oriented.",
    "Static particulars để CANDIDATE — không confirm bừa.",
    "Voyage/lịch cảng UNSUPPORTED: không có căn cứ nào trong dự án.",
    "Phạm vi địa lý hẹp -> phase sau phải cân nhắc trước khi đưa vào resolver toàn cầu.",
  ],
});

// ---------------------------------------------------------------------------
//  MARINETRAFFIC_LIVE — chưa có crawler, KHÔNG bật.
// ---------------------------------------------------------------------------
const MARINETRAFFIC_LIVE = defineSourceCapability({
  source: VesselSource.MARINETRAFFIC_LIVE,
  operations: {
    searchByName: true,
    searchByMmsi: true,
    searchByImo: true,
    position: true,
    particulars: true,
    voyage: true,
    areaScan: true,
  },
  fields: buildFieldSupport(CANDIDATE),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: 70,
  notes: [
    "KHÔNG có crawler implementation trong repo và KHÔNG được bật ở phase này.",
    "Capability khai để kiến trúc có chỗ cắm; mọi field là CANDIDATE, chưa audit gì.",
    "enabled=false: bật lên phải là quyết định riêng, kèm audit điều khoản sử dụng.",
  ],
});

// ---------------------------------------------------------------------------
//  SHIPTRAFFIC — dự kiến dùng cho vessel details/particulars. Chưa implementation.
// ---------------------------------------------------------------------------
const SHIPTRAFFIC = defineSourceCapability({
  source: VesselSource.SHIPTRAFFIC,
  operations: {
    searchByName: true,
    searchByMmsi: true,
    searchByImo: true,
    position: false,
    particulars: true,
    voyage: true,
    areaScan: false,
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    [VesselField.MMSI]: CANDIDATE,
    [VesselField.IMO]: CANDIDATE,
    [VesselField.NAME]: CANDIDATE,
    [VesselField.CALLSIGN]: CANDIDATE,
    [VesselField.VESSEL_TYPE]: CANDIDATE,
    [VesselField.FLAG]: CANDIDATE,
    [VesselField.GROSS_TONNAGE]: CANDIDATE,
    [VesselField.DEADWEIGHT]: CANDIDATE,
    [VesselField.BUILT_YEAR]: CANDIDATE,
    [VesselField.LENGTH]: CANDIDATE,
    [VesselField.BEAM]: CANDIDATE,
    [VesselField.DRAUGHT]: CANDIDATE,
    [VesselField.DESTINATION]: CANDIDATE,
    [VesselField.ETA]: CANDIDATE,
  }),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: 40,
  notes: [
    "Chưa có implementation. Không network request trong P2.",
    "Vai trò dự kiến: vessel details/particulars -> nhóm Position để UNSUPPORTED.",
  ],
});

// ---------------------------------------------------------------------------
//  VESSELTRACKER — details/voyage. Chưa implementation, chưa audit provider.
// ---------------------------------------------------------------------------
const VESSELTRACKER = defineSourceCapability({
  source: VesselSource.VESSELTRACKER,
  operations: {
    searchByName: true,
    searchByMmsi: true,
    searchByImo: true,
    position: false,
    particulars: true,
    voyage: true,
    areaScan: false,
  },
  fields: buildFieldSupport(UNSUPPORTED, {
    [VesselField.MMSI]: CANDIDATE,
    [VesselField.IMO]: CANDIDATE,
    [VesselField.NAME]: CANDIDATE,
    [VesselField.CALLSIGN]: CANDIDATE,
    [VesselField.VESSEL_TYPE]: CANDIDATE,
    [VesselField.FLAG]: CANDIDATE,
    [VesselField.GROSS_TONNAGE]: CANDIDATE,
    [VesselField.DEADWEIGHT]: CANDIDATE,
    [VesselField.BUILT_YEAR]: CANDIDATE,
    [VesselField.LENGTH]: CANDIDATE,
    [VesselField.BEAM]: CANDIDATE,
    [VesselField.DRAUGHT]: CANDIDATE,
    [VesselField.DESTINATION]: CANDIDATE,
    [VesselField.ETA]: CANDIDATE,
    [VesselField.CURRENT_PORT]: CANDIDATE,
    [VesselField.NEXT_PORT]: CANDIDATE,
    [VesselField.LAST_PORT]: CANDIDATE,
  }),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: 50,
  notes: [
    "Chưa có implementation. enabled=false cho tới khi provider được audit.",
    "Ứng viên cho nhóm Voyage — hiện là nhóm rỗng nhất của canonical model.",
  ],
});

// ---------------------------------------------------------------------------
//  MYSHIPTRACKING — TRẢ TIỀN. Fallback CUỐI CÙNG.
// ---------------------------------------------------------------------------
//  ⚠️ Toàn bộ field để CANDIDATE: repo này KHÔNG chứa API client, không chứa
//  tài liệu/response mẫu của MyShipTracking. Danh sách field CONFIRMED phải
//  đến từ API task ngoài repo — nâng trạng thái khi có danh sách đó.
const MYSHIPTRACKING = defineSourceCapability({
  source: VesselSource.MYSHIPTRACKING,
  operations: {
    searchByName: true,
    searchByMmsi: true,
    searchByImo: true,
    position: true,
    particulars: true,
    voyage: true,
    areaScan: true,
  },
  fields: buildFieldSupport(CANDIDATE),
  costType: SourceCostType.PAID,
  enabled: true,
  defaultPriority: 900,
  notes: [
    "Paid fallback only. Resolver must place this source last.",
    "P2 KHÔNG implement API client.",
    "Mọi field để CANDIDATE: repo không chứa client/tài liệu/response mẫu để làm bằng chứng. Nâng lên CONFIRMED khi danh sách field của API task được đưa vào.",
    "enabled=true chỉ nói 'được phép dùng', KHÔNG có nghĩa được gọi trước nguồn free — xem defaultPriority.",
  ],
});

// ---------------------------------------------------------------------------
//  UNKNOWN — không phải nguồn thật. Không capability.
// ---------------------------------------------------------------------------
const UNKNOWN = defineSourceCapability({
  source: VesselSource.UNKNOWN,
  operations: { ...NO_OPERATIONS },
  fields: buildFieldSupport(UNSUPPORTED),
  costType: SourceCostType.FREE,
  enabled: false,
  defaultPriority: Number.MAX_SAFE_INTEGER,
  notes: [
    "Giá trị canh biên cho dữ liệu cũ/không nhận dạng được (parseVesselSource trả về đây).",
    "Không bao giờ được chọn làm nguồn.",
  ],
});

/** Bảng tra chính. TypeScript ép phải có ĐỦ mọi VesselSource. */
export const SOURCE_CAPABILITY_MATRIX: Readonly<Record<VesselSource, Readonly<SourceCapability>>> =
  Object.freeze({
    [VesselSource.AISSTREAM]: AISSTREAM,
    [VesselSource.VESSELFINDER]: VESSELFINDER,
    [VesselSource.SHIPINFO]: SHIPINFO,
    [VesselSource.SHIPFINDER]: SHIPFINDER,
    [VesselSource.BOATNERD]: BOATNERD,
    [VesselSource.MARINETRAFFIC_LIVE]: MARINETRAFFIC_LIVE,
    [VesselSource.SHIPTRAFFIC]: SHIPTRAFFIC,
    [VesselSource.VESSELTRACKER]: VESSELTRACKER,
    [VesselSource.MYSHIPTRACKING]: MYSHIPTRACKING,
    [VesselSource.UNKNOWN]: UNKNOWN,
  });
