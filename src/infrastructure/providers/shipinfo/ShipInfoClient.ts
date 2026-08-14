// ============================================================================
//  INFRASTRUCTURE · ShipInfoClient — dựng URL + GET HTML. Không hơn.
// ----------------------------------------------------------------------------
//  Trách nhiệm DUY NHẤT: định danh -> URL được robots cho phép -> HTML thô.
//  Không parse, không canonical, không DB, không observation.
//
//  KHÔNG có retry / timeout / backoff / rate limit / cooldown / health ở đây.
//  Những thứ đó đã có ở P4 (SourceRequestExecutor). Viết lại lần nữa là nhân
//  đôi số request lên mà không ai nhìn thấy — xem CRAWL_RUNTIME.md §9.
//  Nối P4 vào là việc của P6.4; ở P6.2 client cố tình để trần.
//
//  ⛔ KHÔNG tìm theo tên. Endpoint duy nhất là `api/find_ship_name.php`, nằm
//  dưới `/api/` mà robots.txt của ShipInfo cấm với mọi user-agent
//  (docs/sources/SHIPINFO_AUDIT.md §6). Không có workaround nào ở đây.
// ============================================================================

export const SHIPINFO_BASE_URL = "https://shipinfo.net";

/**
 * Tên trong URL là TRANG TRÍ. P6.1 đã chứng minh: sai tên vẫn trả đúng tàu, và
 * chính sitemap của ShipInfo còn ghi tên cũ ("Isabelita" -> "JAHAN BROTHERS I").
 * Dùng một hằng số để không giả vờ là ta biết tên trước khi tra.
 */
const URL_NAME_PLACEHOLDER = "vessel";

/**
 * Chỗ trống cho định danh không dùng tới. Đã xác minh trực tiếp:
 *   `IMO-0_MMSI-{mmsi}`  -> tra theo MMSI
 *   `IMO-{imo}_MMSI-0`   -> tra theo IMO
 * (Cả hai đều trả đúng tàu; `IMO-0_MMSI-0` thì ra PHP fatal error.)
 */
const UNKNOWN_IDENTIFIER = "0";

/**
 * Chỉ cần đúng phần `getText` của HttpClient. Khai hẹp lại để test tiêm được
 * hàm giả mà không cần dựng cả HttpClient — KHÔNG phải một tầng kiến trúc mới.
 */
export interface ShipInfoHttpTransport {
  getText(url: string, extraHeaders?: Record<string, string>): Promise<string>;
}

export interface ShipInfoClientDeps {
  http: ShipInfoHttpTransport;
  /** Đổi được để test. Mặc định site thật. */
  baseUrl?: string;
}

/**
 * Định danh phải là chuỗi CHỮ SỐ: nó đi thẳng vào path của URL, ký tự khác có
 * thể bẻ đường dẫn.
 *
 * ⚠️ CỐ Ý KHÔNG kiểm checksum IMO ở đây. Bằng chứng P6.1: `IMO-9999999` (sai
 * checksum ISO 8713) là một trang tàu THẬT trên ShipInfo (ROSA DEI VENTI, 177
 * điểm track). Siết checksum sẽ chặn những lần tra vốn chạy được. Việc đánh
 * giá chất lượng định danh thuộc tầng canonical/observation, không phải client.
 */
function assertDigits(value: string, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    throw new Error(`ShipInfoClient: ${label} phải là chuỗi 1-12 chữ số, nhận "${value}"`);
  }
  return trimmed;
}

export class ShipInfoClient {
  private readonly http: ShipInfoHttpTransport;
  private readonly baseUrl: string;

  constructor(deps: ShipInfoClientDeps) {
    this.http = deps.http;
    this.baseUrl = (deps.baseUrl ?? SHIPINFO_BASE_URL).replace(/\/+$/, "");
  }

  /** `/find_vessel_vessel_IMO-{imo}_MMSI-{mmsi}` — đường được robots cho phép. */
  buildVesselUrl(params: { imo?: string; mmsi?: string }): string {
    const imo = params.imo === undefined ? UNKNOWN_IDENTIFIER : assertDigits(params.imo, "IMO");
    const mmsi =
      params.mmsi === undefined ? UNKNOWN_IDENTIFIER : assertDigits(params.mmsi, "MMSI");

    if (imo === UNKNOWN_IDENTIFIER && mmsi === UNKNOWN_IDENTIFIER) {
      throw new Error("ShipInfoClient: cần ít nhất một trong IMO hoặc MMSI");
    }
    return `${this.baseUrl}/find_vessel_${URL_NAME_PLACEHOLDER}_IMO-${imo}_MMSI-${mmsi}`;
  }

  /**
   * HTML trang tàu, tra theo IMO.
   * ⚠️ HTTP 200 KHÔNG có nghĩa là tàu tồn tại — ShipInfo trả 200 kèm PHP fatal
   * error cho tàu không có. Người gọi phải đưa HTML qua `parseShipInfoHtml`.
   */
  async fetchByImo(imo: string): Promise<string> {
    // `async` có chủ ý: định danh sai phải thành REJECTED PROMISE, không phải
    // throw đồng bộ. Hàm trả Promise mà ném đồng bộ sẽ nổ ngoài `.catch()`.
    return this.http.getText(this.buildVesselUrl({ imo }));
  }

  /** HTML trang tàu, tra theo MMSI (dùng `IMO-0`). Cùng cảnh báo về HTTP 200. */
  async fetchByMmsi(mmsi: string): Promise<string> {
    return this.http.getText(this.buildVesselUrl({ mmsi }));
  }
}
