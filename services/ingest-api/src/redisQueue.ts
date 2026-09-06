import { createClient } from "redis";
import type { QueuePublisher, PaymentRecord } from "@paybridge/shared";

const QUEUE_KEY = "payments";

export class RedisQueuePublisher implements QueuePublisher {
  private client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  private ready = this.client.connect();

  async publish(event: PaymentRecord): Promise<void> {
    await this.ready;
    await this.client.lPush(QUEUE_KEY, JSON.stringify(event));
  }
}
