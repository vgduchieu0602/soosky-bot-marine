// ============================================================================
//  INFRASTRUCTURE · MyShipTrackingClient — MỘT endpoint, MỘT request
// ----------------------------------------------------------------------------
//  Trách nhiệm: dựng request · xác thực · timeout · đọc envelope · phân loại
//  lỗi · lấy header credit. HẾT.
//
//  ⛔ Không Mongo, không observation, không resolver, không logic tính tiền/
//     người dùng.
//
//  ⚠️ KHÔNG dùng `HttpClient` dùng chung, và đây là lý do: nó nuốt mã trạng thái
//     thành lỗi chung (`403`/`429` -> `SCRAPE_BLOCKED`) và không cho đọc header.
//     Nguồn trả tiền cần phân biệt **402 hết credit** với **403 không có quyền**,
//     và cần đọc `X-Credit-Charged`. Gộp hai thứ đó lại là mất đúng thông tin
//     đắt nhất.
// ============================================================================

import {
  CREDIT_CHARGED_HEADER,
  MYSHIPTRACKING_DEFAULT_BASE_URL,
  MYSHIPTRACKING_VESSEL_PATH,
  MyShipTrackingEnvelope,
  MyShipTrackingErrorCode,
  MyShipTrackingResponseType,
  MyShipTrackingSimpleData,
} from "./MyShipTrackingTypes";

/** Vì sao một lần gọi trả tiền không cho ra dữ liệu. */
export const MyShipTrackingFailure = {
  /** 404 — AIS bờ chưa thấy tàu này. KHÔNG có nghĩa tàu không tồn tại. */
  NOT_FOUND: "NOT_FOUND",
  /** 402 — hết credit. KHÔNG retry, và KHÔNG phải "nguồn hỏng". */
  NO_CREDITS: "NO_CREDITS",
  /** 401/403 — key sai hoặc không có quyền. Lỗi cấu hình, retry vô nghĩa. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** 400 — ta gửi sai tham số. Lỗi CỦA TA, không phải nguồn hỏng. */
  BAD_REQUEST: "BAD_REQUEST",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  /** Trả 200 nhưng envelope không đọc được. */
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
} as const;

export type MyShipTrackingFailure =
  (typeof MyShipTrackingFailure)[keyof typeof MyShipTrackingFailure];

export type MyShipTrackingFetchResult =
  | {
      readonly ok: true;
      readonly data: MyShipTrackingSimpleData;
      /** Từ header `X-Credit-Charged`. Vắng mặt -> `undefined`, KHÔNG bịa số. */
      readonly creditCharged?: number;
    }
  | {
      readonly ok: false;
      readonly failure: MyShipTrackingFailure;
      /** Mã lỗi nguồn khai, nếu đọc được. */
      readonly code?: string;
      readonly creditCharged?: number;
    };

/** Chỉ đúng phần `fetch` mà client cần — tiêm được để test không chạm mạng. */
export interface MyShipTrackingTransport {
  request(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

/** Transport thật. Tách ra để test tiêm bản giả mà không đụng `fetch` toàn cục. */
export const fetchTransport: MyShipTrackingTransport = {
  async request(url, headers, timeoutMs) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const collected: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      collected[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: collected, body: await response.text() };
  },
};

export interface MyShipTrackingClientDeps {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  transport?: MyShipTrackingTransport;
}

export interface MyShipTrackingQuery {
  /** ĐÚNG MỘT trong hai. Gửi cả hai là 400 `ERR_INVALID_IDENTIFIER`. */
  readonly mmsi?: string;
  readonly imo?: string;
}

export class MyShipTrackingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MyShipTrackingConfigError";
  }
}

export class MyShipTrackingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transport: MyShipTrackingTransport;

  constructor(deps: MyShipTrackingClientDeps) {
    if (deps.apiKey.trim() === "") {
      // Nói rõ NGAY khi dựng, không để lộ ra thành 401 sau khi đã tốn một lượt.
      throw new MyShipTrackingConfigError("Thiếu MYSHIPTRACKING_API_KEY");
    }
    this.apiKey = deps.apiKey;
    this.baseUrl = (deps.baseUrl ?? MYSHIPTRACKING_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.transport = deps.transport ?? fetchTransport;
  }

  /**
   * ĐÚNG MỘT request. Không retry.
   *
   * ⚠️ Cố ý KHÔNG retry, kể cả 5xx: tài liệu không nói rõ một request lỗi giữa
   * chừng đã bị trừ credit hay chưa. Không chắc thì không thử lại — rẻ hơn cho
   * người dùng, và một lượt trượt vẫn có thể lấy lại bằng lần bấm sau.
   */
  async fetchCurrentPosition(query: MyShipTrackingQuery): Promise<MyShipTrackingFetchResult> {
    const url = this.buildUrl(query);

    let response: { status: number; headers: Record<string, string>; body: string };
    try {
      response = await this.transport.request(
        url,
        {
          // Bearer thay vì `x-api-key`: cả hai tương đương theo tài liệu, chọn
          // một để chỉ có một đường phải giữ bí mật.
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
        },
        this.timeoutMs
      );
    } catch (error) {
      const name = (error as { name?: string }).name;
      return {
        ok: false,
        failure:
          name === "TimeoutError" || name === "AbortError"
            ? MyShipTrackingFailure.TIMEOUT
            : MyShipTrackingFailure.NETWORK_ERROR,
      };
    }

    const creditCharged = MyShipTrackingClient.readCredit(response.headers);
    const envelope = MyShipTrackingClient.parse(response.body);

    if (response.status === 200 && envelope?.status === "success") {
      const data = envelope.data;
      if (data === undefined || typeof data !== "object") {
        return { ok: false, failure: MyShipTrackingFailure.MALFORMED_RESPONSE, creditCharged };
      }
      return { ok: true, data, ...(creditCharged === undefined ? {} : { creditCharged }) };
    }

    const code = envelope !== null && "code" in envelope ? envelope.code : undefined;
    return {
      ok: false,
      failure: MyShipTrackingClient.classify(response.status, code),
      ...(code === undefined ? {} : { code }),
      ...(creditCharged === undefined ? {} : { creditCharged }),
    };
  }

  /**
   * ⚠️ CHỈ `response=simple`. `extended` tốn 3 credit và chỉ thêm nhóm mà đường
   * free đã lo — không có đường nào trong TRACK-1 đặt được giá trị đó.
   */
  private buildUrl(query: MyShipTrackingQuery): string {
    const mmsi = query.mmsi?.trim();
    const imo = query.imo?.trim();

    // Gửi cả hai là 400 theo tài liệu ("exactly one identifier is required").
    // Ưu tiên MMSI, đúng thứ tự mà cả canonical lẫn `MongoCurrentVesselRepository`
    // đang dùng — và cũng là khoá mà map trao cho người dùng.
    const params = new URLSearchParams({ response: MyShipTrackingResponseType.SIMPLE });
    if (mmsi !== undefined && mmsi !== "") params.set("mmsi", mmsi);
    else if (imo !== undefined && imo !== "") params.set("imo", imo);
    else throw new MyShipTrackingConfigError("Cần đúng một trong MMSI hoặc IMO");

    return `${this.baseUrl}${MYSHIPTRACKING_VESSEL_PATH}?${params.toString()}`;
  }

  private static parse(body: string): MyShipTrackingEnvelope | null {
    try {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as MyShipTrackingEnvelope)
        : null;
    } catch {
      return null;
    }
  }

  private static readCredit(headers: Record<string, string>): number | undefined {
    const raw = headers[CREDIT_CHARGED_HEADER];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    // Header có mà đọc không ra số -> `undefined`, KHÔNG đoán 1.
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  /** Mã lỗi nguồn khai được ưu tiên; HTTP status là đường dự phòng. */
  private static classify(status: number, code: string | undefined): MyShipTrackingFailure {
    switch (code) {
      case MyShipTrackingErrorCode.NO_CREDITS:
        return MyShipTrackingFailure.NO_CREDITS;
      case MyShipTrackingErrorCode.VESSEL_NOT_FOUND:
        return MyShipTrackingFailure.NOT_FOUND;
      case MyShipTrackingErrorCode.RATE_LIMIT:
        return MyShipTrackingFailure.RATE_LIMITED;
      case MyShipTrackingErrorCode.NO_KEY:
      case MyShipTrackingErrorCode.INVALID_KEY:
      case MyShipTrackingErrorCode.NO_ACCESS:
        return MyShipTrackingFailure.UNAUTHORIZED;
      case MyShipTrackingErrorCode.VALIDATOR:
      case MyShipTrackingErrorCode.INVALID_IDENTIFIER:
        return MyShipTrackingFailure.BAD_REQUEST;
      default:
        break;
    }

    if (status === 402) return MyShipTrackingFailure.NO_CREDITS;
    if (status === 404) return MyShipTrackingFailure.NOT_FOUND;
    if (status === 429) return MyShipTrackingFailure.RATE_LIMITED;
    if (status === 401 || status === 403) return MyShipTrackingFailure.UNAUTHORIZED;
    if (status === 400) return MyShipTrackingFailure.BAD_REQUEST;
    if (status >= 500) return MyShipTrackingFailure.SERVER_ERROR;
    return MyShipTrackingFailure.MALFORMED_RESPONSE;
  }
}
