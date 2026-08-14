// ============================================================================
//  APPLICATION · ProviderRegistry — SỔ ĐĂNG KÝ provider, KHÔNG hơn
// ----------------------------------------------------------------------------
//  Trả lời đúng một câu: "hiện có provider implementation nào, cho nguồn nào".
//
//  KHÔNG làm (cố ý, đừng thêm vào):
//    fallback · retry · rate limit · merge · chấm điểm · chọn nguồn tốt nhất
//    · truy cập DB · gọi HTTP · đọc capability matrix
//  Tất cả những thứ đó thuộc resolver — CHƯA tồn tại (Phase sau).
//
//  Không DI framework, không decorator, không dynamic loader. Một Map.
// ============================================================================

import { VesselSource } from "../../domain/value-objects/VesselSource";
import {
  ProviderOperation,
  VesselDataProvider,
  providerSupportsOperation,
} from "./VesselDataProvider";

export class ProviderRegistry {
  /** Map giữ nguyên THỨ TỰ đăng ký -> getAll() ổn định, test không flaky. */
  private readonly providers = new Map<VesselSource, VesselDataProvider>();

  /**
   * @throws Error khi source đã có provider (KHÔNG ghi đè im lặng — hai
   *         implementation cùng một nguồn là lỗi lắp ráp, phải nổ ở composition
   *         root chứ không phải sai lệch dữ liệu lúc chạy).
   * @throws Error khi source là UNKNOWN — đó là giá trị canh biên cho dữ liệu
   *         cũ không nhận dạng được, không phải một nguồn thật.
   */
  register(provider: VesselDataProvider): void {
    if (provider.source === VesselSource.UNKNOWN) {
      throw new Error("Không thể đăng ký provider cho VesselSource.UNKNOWN");
    }
    if (this.providers.has(provider.source)) {
      throw new Error(`Provider cho nguồn "${provider.source}" đã được đăng ký`);
    }
    this.providers.set(provider.source, provider);
  }

  get(source: VesselSource): VesselDataProvider | undefined {
    return this.providers.get(source);
  }

  has(source: VesselSource): boolean {
    return this.providers.has(source);
  }

  /** Bản sao đóng băng — người gọi không sửa được sổ đăng ký. */
  getAll(): readonly VesselDataProvider[] {
    return Object.freeze([...this.providers.values()]);
  }

  /** Nguồn đã có provider, theo thứ tự đăng ký. */
  getRegisteredSources(): readonly VesselSource[] {
    return Object.freeze([...this.providers.keys()]);
  }

  /**
   * Provider THỰC SỰ implement operation này. Provider đăng ký rồi mà thiếu
   * method thì không lọt vào đây.
   */
  getForOperation(operation: ProviderOperation): readonly VesselDataProvider[] {
    return Object.freeze(
      [...this.providers.values()].filter((provider) =>
        providerSupportsOperation(provider, operation)
      )
    );
  }

  get size(): number {
    return this.providers.size;
  }
}
