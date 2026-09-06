import type { EmailSender, PaymentRecord } from "@paybridge/shared";

export class ConsoleEmailSender implements EmailSender {
  async sendConfirmation(record: PaymentRecord): Promise<void> {
    console.log(
      `[email] confirmation sent to ${record.customer_name} for ${record.source} payment ${record.source_event_id} ($${record.amount} ${record.currency})`
    );
  }
}
