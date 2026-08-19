import Anthropic from '@anthropic-ai/sdk';

/**
 * SRE resilience: queued, rate-limited wrapper around Anthropic.
 * Prevents 429 bursts when oracle + explainer + dream + planner fire together.
 * Concurrency 3, 10 calls per 60s window — tunable.
 */
class SimpleLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  private windowStart = Date.now();
  private callsInWindow = 0;
  private readonly concurrency: number;
  private readonly intervalCap: number;
  private readonly intervalMs: number;

  constructor(opts: { concurrency: number; intervalCap: number; intervalMs: number }) {
    this.concurrency = opts.concurrency;
    this.intervalCap = opts.intervalCap;
    this.intervalMs = opts.intervalMs;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        // Window reset
        const now = Date.now();
        if (now - this.windowStart >= this.intervalMs) {
          this.windowStart = now;
          this.callsInWindow = 0;
        }
        if (this.callsInWindow >= this.intervalCap) {
          const wait = this.intervalMs - (now - this.windowStart) + 50;
          await new Promise(r => setTimeout(r, wait));
          this.windowStart = Date.now();
          this.callsInWindow = 0;
        }
        this.callsInWindow++;
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          this.running--;
          const next = this.queue.shift();
          if (next) next();
        }
      };

      if (this.running < this.concurrency) run();
      else this.queue.push(run);
    });
  }
}

const limiter = new SimpleLimiter({ concurrency: 3, intervalCap: 10, intervalMs: 60_000 });

export const anthropicLimiter = limiter;

export async function limitedCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  return limiter.add(() => client.messages.create(params) as Promise<Anthropic.Message>);
}
