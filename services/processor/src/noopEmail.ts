import type { EmailSender } from "@paybridge/shared";

export class NoopEmailSender implements EmailSender {
  async sendConfirmation(): Promise<void> {
    // no-op — real implementation in Phase 2
  }
}
