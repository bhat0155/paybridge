import { z } from "zod";

export const PaymentRecordSchema = z.object({
  record_id: z.string().uuid(),
  source: z.enum(["stripe", "qb"]),
  source_event_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  customer_name: z.string(),
  description: z.string(),
  status: z.string(),
  event_timestamp: z.string().datetime(),
});

export type PaymentRecord = z.infer<typeof PaymentRecordSchema>;
