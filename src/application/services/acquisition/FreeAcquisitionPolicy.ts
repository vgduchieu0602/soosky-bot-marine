// ============================================================================
//  APPLICATION · Chính sách của vòng acquisition free
// ----------------------------------------------------------------------------
//  Một con số duy nhất ở phase này. Thêm nút vặn khi chưa có ai cần vặn là tạo
//  bề mặt cấu hình phải bảo trì mà không đổi được hành vi nào.
// ============================================================================

export interface FreeAcquisitionPolicy {
  /**
   * Số lần CHẠM NGUỒN tối đa cho một yêu cầu.
   *
   * 2, theo ACQUISITION_POLICY.md §I.1 — hai lý do đo được:
   *
   *  1. Không need nào có nhiều hơn 2 nguồn hữu ích. Đếm nguồn vừa có provider
   *     vừa CONFIRMED field cần: vị trí -> 2 · `destination` -> 1 · `builtYear`
   *     -> 1 · `name` -> 3. Ngân sách 2 chỉ thực sự cắt ở `IDENTITY`, nơi nguồn
   *     thứ ba gần như chắc chắn lặp lại điều hai nguồn đầu đã nói.
   *
   *  2. Thời gian. ShipInfo timeout 20s + nghỉ 3–8s; ShipFinder 15s + nghỉ 3–8s.
   *     Xấu nhất hai lần ≈ 56 giây. Lần thứ ba đẩy quá 60s — vượt ngưỡng chờ
   *     của bất kỳ yêu cầu tương tác nào.
   *
   * ⚠️ Đếm MỌI lần chạm nguồn, kể cả `NOT_FOUND` và lỗi. Nếu chỉ đếm lần thành
   * công thì một nguồn hỏng liên tục sẽ không bao giờ tiêu hết ngân sách.
   */
  readonly maxAttemptsPerRequest: number;
}

export const DEFAULT_FREE_ACQUISITION_POLICY: Readonly<FreeAcquisitionPolicy> = Object.freeze({
  maxAttemptsPerRequest: 2,
});
