import { describe, expect, it } from "vitest";
import { normalizeStripeEvent, normalizeQuickBooksEvent } from "./normalize";

describe("normalizeStripeEvent", () => {
  it("converts cents to dollars and extracts the billing name", () => {
    const event = {
      data: {
        object: {
          id: "ch_3NxAB2K",
          amount: 2000,
          currency: "usd",
          billing_details: { name: "John Smith" },
          description: "Pizza order #482",
          status: "succeeded",
          created: 1767456000,
        },
      },
    } as any;

    const record = normalizeStripeEvent(event);

    expect(record.amount).toBe(20);
    expect(record.currency).toBe("USD");
    expect(record.customer_name).toBe("John Smith");
    expect(record.source_event_id).toBe("ch_3NxAB2K");
  });
});

describe("normalizeQuickBooksEvent", () => {
  it("maps invoice_id to source_event_id and passes amount through unchanged", () => {
    const record = normalizeQuickBooksEvent({
      invoice_id: "INV-1042",
      customer: "John Smith",
      amount_due: 20.0,
      currency: "USD",
      memo: "Pizza order #482",
      status: "paid",
      issued_date: "2026-09-03",
    });

    expect(record.source).toBe("qb");
    expect(record.source_event_id).toBe("INV-1042");
    expect(record.amount).toBe(20.0);
  });
});
