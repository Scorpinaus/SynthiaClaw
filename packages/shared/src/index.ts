import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("synthia-server"),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
