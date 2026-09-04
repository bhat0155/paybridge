import type { QueuePublisher, PaymentRecord } from "@paybridge/shared";

export class NoopQueuePublisher implements QueuePublisher {
  async publish(event: PaymentRecord): Promise<void> {
    // no-op — real implementation in Phase 2
  }
}
