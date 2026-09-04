import express from "express";
import type { PaymentRecord } from "@paybridge/shared";

const app = express();

app.get("/transactions", async (req, res) => {
  // real DB read arrives in Phase 2 — no DB exists yet
  const transactions: PaymentRecord[] = [];
  res.json(transactions);
});

const port = process.env.PORT ?? 3003;
app.listen(port, () => {
  console.log(`reconciliation-api listening on port ${port}`);
});
