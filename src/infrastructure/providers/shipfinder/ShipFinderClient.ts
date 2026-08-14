// ============================================================================
//  INFRASTRUCTURE · ShipFinderClient — dựng URL + GET HTML. Không hơn.
// ----------------------------------------------------------------------------
//  Trách nhiệm DUY NHẤT: MMSI -> URL công khai -> HTML thô.
//  Không parse, không canonical, không DB, không observation.
//
//  KHÔNG có retry / timeout / backoff / rate limit / cooldown ở đây — đã có ở
//  P4 (SourceRequestExecutor). Nối vào là việc của phase sau.
//
//  ⛔ CHỈ TRA THEO MMSI. Audit P7.1 đã chứng minh:
//     `/ship/detail/imo/{imo}` -> 404, và đưa IMO vào khe mmsi thì trang trả
//     HTTP 200 với mọi ô là "-". Không có đường tra theo IMO.
//
//  ⛔ KHÔNG chạm API JSON (`/Ship/GetShip`, `/ship/GetIHSData`, …): chúng đòi
//  header `s` (chữ ký MD5) + `t` và trả 401 nếu thiếu. Đó là rào chống tự động
//  hoá có chủ ý của nhà vận hành — không tái tạo chữ ký, không dùng cookie để
//  lách, không dùng trình duyệt để lấy chữ ký. Trang công khai đã đủ dữ liệu.
//
//  ⛔ KHÔNG tìm theo tên: endpoint duy nhất (`/Home/Suggest`) cũng bị ký chữ ký.
// ============================================================================

import { isValidMmsi } from "../../../domain/validators/identifiers";

export const SHIPFINDER_BASE_URL = "https://www.shipfinder.com";

/**
 * Chỉ cần đúng phần `getText`. Khai hẹp để test tiêm hàm giả mà không phải
 * dựng cả HttpClient — KHÔNG phải một tầng kiến trúc mới.
 */
export interface ShipFinderHttpTransport {
  getText(url: string, extraHeaders?: Record<string, string>): Promise<string>;
}

export interface ShipFinderClientDeps {
  http: ShipFinderHttpTransport;
  /** Đổi được để test. Mặc định site thật. */
  baseUrl?: string;
}

export class ShipFinderClient {
  private readonly http: ShipFinderHttpTransport;
  private readonly baseUrl: string;

  constructor(deps: ShipFinderClientDeps) {
    this.http = deps.http;
    this.baseUrl = (deps.baseUrl ?? SHIPFINDER_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * `/ship/detail/mmsi/{mmsi}` — đường công khai, `robots.txt` cho phép toàn bộ.
   *
   * Dùng validator MMSI của P1 (9 chữ số, chữ số đầu khác 0). Ở đây siết chặt
   * là AN TOÀN, khác với ShipInfo: bên đó ta cố ý KHÔNG kiểm checksum IMO vì có
   * bằng chứng trang thật mang IMO sai checksum. Còn MMSI thì trục tra duy nhất
   * của ShipFinder, và mọi URL trong sitemap của họ đều đúng dạng 9 chữ số.
   *
   * @throws Error khi MMSI không hợp lệ — chặn TRƯỚC khi chạm mạng, và cũng
   *         chặn luôn ký tự lạ chen vào path.
   */
  buildVesselUrl(mmsi: string | number): string {
    const value = String(mmsi ?? "").trim();
    if (!isValidMmsi(value)) {
      throw new Error(
        `ShipFinderClient: MMSI không hợp lệ: "${mmsi}" (cần 9 chữ số, không bắt đầu bằng 0)`
      );
    }
    return `${this.baseUrl}/ship/detail/mmsi/${value}`;
  }

  /**
   * HTML trang tàu.
   *
   * ⚠️ HTTP 200 KHÔNG có nghĩa là tàu tồn tại — ShipFinder trả 200 kèm trang
   * đầy đủ nhưng mọi ô là "-". Người gọi phải đưa HTML qua `parseShipFinderHtml`.
   *
   * `async` có chủ ý: MMSI sai phải thành rejected promise, không phải throw
   * đồng bộ từ một hàm trả Promise.
   */
  async fetchByMmsi(mmsi: string | number): Promise<string> {
    return this.http.getText(this.buildVesselUrl(mmsi));
  }
}
