import express from "express";
import type { PaymentRecord } from "@paybridge/shared";
import { NoopQueuePublisher } from "./noopQueue";

const app = express();
app.use(express.json());

const publisher = new NoopQueuePublisher();

app.post("/webhooks/stripe", async (req, res) => {
  // signature verification + normalization into PaymentRecord arrive in Phase 2
  const event = req.body as PaymentRecord;
  await publisher.publish(event);
  res.status(202).send();
});

const port = process.env.PORT ?? 3001;
app.listen(port, () => {
  console.log(`ingest-api listening on port ${port}`);
});
