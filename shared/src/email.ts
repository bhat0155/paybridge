import type { PaymentRecord } from "./schema";

export interface EmailSender {
  sendConfirmation(record: PaymentRecord): Promise<void>;
}
