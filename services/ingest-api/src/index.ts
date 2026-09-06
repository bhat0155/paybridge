import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { ZodError } from "zod";
import { PaymentRecordSchema } from "@paybridge/shared";
import { RedisQueuePublisher } from "./redisQueue";
import { normalizeStripeEvent, normalizeQuickBooksEvent } from "./normalize";

const app = express();
const publisher = new RedisQueuePublisher();
// Only used to call stripe.webhooks.constructEvent() — never makes a real Stripe API call.
const stripe = new Stripe(process.env.STRIPE_API_KEY ?? "sk_test_not_used_for_webhook_verification");

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"] as string,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    return res.status(400).send("signature verification failed");
  }

  // Stripe fires several related event types per transaction (payment_intent.created,
  // payment_intent.succeeded, charge.updated, ...) — contracts.md only defines
  // normalization for charge.succeeded. Acknowledge the rest without recording them,
  // so Stripe doesn't retry them as if they'd failed.
  if (event.type !== "charge.succeeded") {
    res.status(200).send();
    return;
  }

  try {
    const record = PaymentRecordSchema.parse(normalizeStripeEvent(event));
    await publisher.publish(record);
    res.status(202).send();
  } catch (err) {
    handleIngestError(err, res);
  }
});

app.post("/webhooks/quickbooks", express.json(), async (req, res) => {
  try {
    const record = PaymentRecordSchema.parse(normalizeQuickBooksEvent(req.body));
    await publisher.publish(record);
    res.status(202).send();
  } catch (err) {
    handleIngestError(err, res);
  }
});

function handleIngestError(err: unknown, res: express.Response): void {
  // Express 4 does not catch rejections from async handlers on its own —
  // without this, a bad payload or a down Redis would crash the whole process.
  if (err instanceof ZodError) {
    console.error("[ingest-api] invalid payload after normalization:", err.issues);
    res.status(400).json({ error: "invalid payload" });
    return;
  }
  console.error("[ingest-api] failed to process webhook:", err);
  res.status(500).json({ error: "failed to process webhook" });
}

const port = process.env.PORT ?? 3001;
app.listen(port, () => {
  console.log(`ingest-api listening on port ${port}`);
});
