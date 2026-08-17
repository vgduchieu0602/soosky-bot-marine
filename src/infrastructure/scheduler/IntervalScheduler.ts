// ============================================================================
//  INFRASTRUCTURE · Scheduler: chạy 1 việc định kỳ (vd mỗi 2 giờ) bằng setInterval
// ----------------------------------------------------------------------------
//  KHÔNG chạy chồng: tick nào tới trong khi lần chạy trước chưa xong thì bỏ
//  qua. Việc dài hơn chu kỳ (crawl/scan/cleanup) vì thế không nhân bản tải lên
//  upstream hay DB.
// ============================================================================

export interface IntervalSchedulerDeps {
  everyMs: number;
  task: () => Promise<void>;
  runOnStart?: boolean;
  /** Tên việc để log rõ đang hẹn giờ cho cái gì. */
  label?: string;
}

export class IntervalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private runPromise: Promise<void> | null = null;
  private stats = { started: 0, completed: 0, failed: 0, skippedOverlaps: 0 };

  constructor(private readonly deps: IntervalSchedulerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    const label = this.deps.label ?? "công việc";
    const minutes = (this.deps.everyMs / 60000).toFixed(1);
    console.log(`⏰ Scheduler: chạy "${label}" mỗi ${minutes} phút.`);
    if (this.deps.runOnStart ?? true) void this.safeRun();
    this.timer = setInterval(() => void this.safeRun(), this.deps.everyMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.runPromise;
  }

  getStats(): Readonly<typeof this.stats> & { running: boolean; scheduled: boolean } {
    return { ...this.stats, running: this.running, scheduled: this.timer !== null };
  }

  private async safeRun(): Promise<void> {
    // Lần chạy trước còn đang dở -> bỏ tick này (không xếp hàng, không chồng).
    if (this.running) {
      this.stats.skippedOverlaps += 1;
      return;
    }
    this.running = true;
    const run = (async (): Promise<void> => {
      this.stats.started += 1;
      try {
      await this.deps.task();
        this.stats.completed += 1;
      } catch (err) {
        this.stats.failed += 1;
        console.error(`⚠️  Scheduler lỗi: ${(err as Error).message}`);
      } finally {
        this.running = false;
      }
    })();
    this.runPromise = run;
    try {
      await run;
    } finally {
      if (this.runPromise === run) this.runPromise = null;
    }
  }
}
