import "dotenv/config";
import { getPool, ensureSchema } from "@paybridge/shared";
import { RedisQueueConsumer } from "./redisQueue";
import { ConsoleEmailSender } from "./consoleEmail";

const consumer = new RedisQueueConsumer();
const emailSender = new ConsoleEmailSender();

async function main() {
  await ensureSchema();
  const pool = await getPool();

  consumer.consume(async (event) => {
    try {
      await pool
        .request()
        .input("record_id", event.record_id)
        .input("source", event.source)
        .input("source_event_id", event.source_event_id)
        .input("amount", event.amount)
        .input("currency", event.currency)
        .input("customer_name", event.customer_name)
        .input("description", event.description)
        .input("status", event.status)
        .input("event_timestamp", new Date(event.event_timestamp))
        .query(`
          INSERT INTO payments
            (record_id, source, source_event_id, amount, currency, customer_name, description, status, event_timestamp)
          VALUES
            (@record_id, @source, @source_event_id, @amount, @currency, @customer_name, @description, @status, @event_timestamp)
        `);
    } catch (err: any) {
      if (err.number === 2627 || err.number === 2601) {
        console.log(`[processor] duplicate event ${event.source_event_id} — already processed, skipping`);
        return;
      }
      // Once popped from Redis, this event is gone — there is no local DLQ to retry from
      // (that's a Phase 5+ Service Bus feature). Log loudly instead of crashing the whole
      // worker over one bad event; a real alert on this is also Phase 10 scope.
      console.error(`[processor] FAILED to record event ${event.source_event_id}:`, err);
      return;
    }

    await emailSender.sendConfirmation(event);
  });

  console.log("processor started");
}

main();
