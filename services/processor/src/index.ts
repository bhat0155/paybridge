import { NoopQueueConsumer } from "./noopQueue";
import { NoopEmailSender } from "./noopEmail";

const consumer = new NoopQueueConsumer();
const emailSender = new NoopEmailSender();

consumer.consume(async (event) => {
  // writing to Azure SQL + calling emailSender.sendConfirmation(event) arrive in Phase 2
});

console.log("processor started");
