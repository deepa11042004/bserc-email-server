// Token-bucket rate limiter to respect SES per-second send rate.
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const need = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((need / this.refillPerSec) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
