import type { PaymentRecord } from "./schema";

export interface QueuePublisher {
  publish(event: PaymentRecord): Promise<void>;
}

export interface QueueConsumer {
  consume(handler: (event: PaymentRecord) => Promise<void>): void;
}
