/** Process-local idempotency for the Bot's single-instance internal command endpoint. */
export class AcquisitionRequestRegistry {
  private readonly entries = new Map<string, { expiresAt: number; result: Promise<unknown> }>();

  constructor(private readonly policy: { ttlMs: number; maxEntries: number }, private readonly now: () => Date = () => new Date()) {}

  run<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    this.cleanup();
    const existing = this.entries.get(requestId);
    if (existing !== undefined) return existing.result as Promise<T>;
    while (this.entries.size >= this.policy.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const result = operation();
    this.entries.set(requestId, { expiresAt: this.now().getTime() + this.policy.ttlMs, result });
    return result;
  }

  private cleanup(): void {
    const nowMs = this.now().getTime();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= nowMs) this.entries.delete(key);
  }
}
