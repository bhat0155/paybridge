import type { QueueConsumer, PaymentRecord } from "@paybridge/shared";

export class NoopQueueConsumer implements QueueConsumer {
  consume(handler: (event: PaymentRecord) => Promise<void>): void {
    // no-op — real implementation in Phase 2
  }
}
