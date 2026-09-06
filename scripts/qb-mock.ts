import "dotenv/config";

const INGEST_URL = process.env.INGEST_API_URL ?? "http://localhost:3001";
const INTERVAL_MS = 30_000;
let counter = 0;

async function fireMockInvoice() {
  counter += 1;
  const payload = {
    invoice_id: `INV-MOCK-${Date.now()}-${counter}`,
    customer: "John Smith",
    amount_due: 20.0,
    currency: "USD",
    memo: "Pizza order #482",
    status: "paid",
    issued_date: new Date().toISOString().slice(0, 10),
  };

  const response = await fetch(`${INGEST_URL}/webhooks/quickbooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log(`[qb-mock] sent ${payload.invoice_id} → ${response.status}`);
}

console.log(`[qb-mock] firing a mock invoice every ${INTERVAL_MS / 1000}s`);
setInterval(fireMockInvoice, INTERVAL_MS);
fireMockInvoice();
