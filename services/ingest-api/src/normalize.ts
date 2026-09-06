import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { PaymentRecord } from "@paybridge/shared";

export function normalizeStripeEvent(event: Stripe.Event): PaymentRecord {
  const charge = event.data.object as Stripe.Charge;
  return {
    record_id: randomUUID(),
    source: "stripe",
    source_event_id: charge.id,
    amount: charge.amount / 100,
    currency: charge.currency.toUpperCase(),
    customer_name: charge.billing_details?.name ?? "unknown",
    description: charge.description ?? "",
    status: charge.status,
    event_timestamp: new Date(charge.created * 1000).toISOString(),
  };
}

interface QuickBooksInvoicePayload {
  invoice_id: string;
  customer: string;
  amount_due: number;
  currency: string;
  memo: string;
  status: string;
  issued_date: string;
}

export function normalizeQuickBooksEvent(payload: QuickBooksInvoicePayload): PaymentRecord {
  return {
    record_id: randomUUID(),
    source: "qb",
    source_event_id: payload.invoice_id,
    amount: payload.amount_due,
    currency: payload.currency,
    customer_name: payload.customer,
    description: payload.memo,
    status: payload.status,
    event_timestamp: new Date(payload.issued_date).toISOString(),
  };
}
