import "dotenv/config";
import express from "express";
import { getPool } from "@paybridge/shared";
import type { PaymentRecord } from "@paybridge/shared";

const app = express();

app.get("/transactions", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : null;
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("source", source)
      .query(`SELECT * FROM payments WHERE (@source IS NULL OR source = @source) ORDER BY event_timestamp DESC`);
    res.json(result.recordset as PaymentRecord[]);
  } catch (err) {
    // Express 4 does not catch rejections from async handlers on its own —
    // without this, a DB failure here would crash the whole process.
    console.error("[reconciliation-api] failed to read transactions:", err);
    res.status(500).json({ error: "failed to read transactions" });
  }
});

const port = process.env.PORT ?? 3003;
app.listen(port, () => {
  console.log(`reconciliation-api listening on port ${port}`);
});
