import { createClient } from "redis";
import type { QueueConsumer, PaymentRecord } from "@paybridge/shared";

const QUEUE_KEY = "payments";

export class RedisQueueConsumer implements QueueConsumer {
  private client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });

  consume(handler: (event: PaymentRecord) => Promise<void>): void {
    void this.loop(handler);
  }

  private async loop(handler: (event: PaymentRecord) => Promise<void>): Promise<void> {
    await this.client.connect();
    for (;;) {
      const popped = await this.client.brPop(QUEUE_KEY, 0);
      if (!popped) continue;
      await handler(JSON.parse(popped.element) as PaymentRecord);
    }
  }
}
