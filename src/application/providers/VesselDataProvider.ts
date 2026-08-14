// ============================================================================
//  APPLICATION · PORT: VesselDataProvider — adapter của MỘT nguồn dữ liệu
// ----------------------------------------------------------------------------
//  Khác `IVesselDetailsSource`/`IAreaScanner` (vẫn đang chạy production) ở 3 điểm:
//    1. Có `source` -> biết dữ liệu từ đâu mà không cần hỏi ai.
//    2. Nhận `VesselIdentifier` thay vì `string` mơ hồ.
//    3. Trả canonical + SourceMetadata, không trả entity cũ.
//
//  MỌI method là OPTIONAL. Nguồn chỉ có vị trí thì chỉ implement `getPosition`;
//  nguồn chỉ có lý lịch thì chỉ implement `getDetails`. KHÔNG có method nào ném
//  "not implemented" — vắng mặt method LÀ câu trả lời, và `ProviderRegistry`
//  kiểm tra được điều đó (xem `providerSupportsOperation`).
//
//  Provider KHÔNG chịu trách nhiệm: fallback, merge, retry, rate limit, cache,
//  ghi DB. Nó chỉ biết một nguồn và cách đọc nguồn đó.
// ============================================================================

import { BoundingBox } from "../ports/Geo";
import { VesselIdentifier } from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import {
  ProviderDetailsResult,
  ProviderPositionResult,
  ProviderSearchResult,
} from "./ProviderResults";

export interface VesselDataProvider {
  /** Nguồn mà provider này đại diện. Một source = tối đa một provider. */
  readonly source: VesselSource;

  /** Tìm ứng viên theo tên. Trả rỗng khi không thấy — không ném. */
  searchByName?(name: string): Promise<readonly ProviderSearchResult[]>;

  /** Vị trí của một tàu đã biết định danh. `null` = nguồn không có tàu này. */
  getPosition?(identifier: VesselIdentifier): Promise<ProviderPositionResult | null>;

  /** Lý lịch/chuyến đi/vị trí của một tàu. `null` = nguồn không có tàu này. */
  getDetails?(identifier: VesselIdentifier): Promise<ProviderDetailsResult | null>;

  /** Quét cả vùng. Trả rỗng khi vùng không có tàu. */
  scanArea?(box: BoundingBox): Promise<readonly ProviderPositionResult[]>;
}

/** Thao tác truy vấn được registry dùng để lọc provider. */
export const ProviderOperation = {
  SEARCH_BY_NAME: "SEARCH_BY_NAME",
  GET_POSITION: "GET_POSITION",
  GET_DETAILS: "GET_DETAILS",
  SCAN_AREA: "SCAN_AREA",
} as const;

export type ProviderOperation = (typeof ProviderOperation)[keyof typeof ProviderOperation];

export const PROVIDER_OPERATIONS: readonly ProviderOperation[] = Object.freeze(
  Object.values(ProviderOperation) as ProviderOperation[]
);

/** Operation -> tên method tương ứng trên interface. */
const OPERATION_METHOD: Readonly<Record<ProviderOperation, keyof VesselDataProvider>> =
  Object.freeze({
    [ProviderOperation.SEARCH_BY_NAME]: "searchByName",
    [ProviderOperation.GET_POSITION]: "getPosition",
    [ProviderOperation.GET_DETAILS]: "getDetails",
    [ProviderOperation.SCAN_AREA]: "scanArea",
  });

/**
 * Provider có làm được operation này không — hỏi CHÍNH implementation, không
 * hỏi capability matrix. Matrix nói "nguồn về lý thuyết hỗ trợ gì"; hàm này nói
 * "code có tồn tại hay không". Hai câu hỏi khác nhau (PROVIDER_ARCHITECTURE.md §2).
 */
export function providerSupportsOperation(
  provider: VesselDataProvider,
  operation: ProviderOperation
): boolean {
  return typeof provider[OPERATION_METHOD[operation]] === "function";
}

/** Mọi operation mà provider thực sự implement. */
export function getProviderOperations(
  provider: VesselDataProvider
): readonly ProviderOperation[] {
  return Object.freeze(
    PROVIDER_OPERATIONS.filter((operation) => providerSupportsOperation(provider, operation))
  );
}
