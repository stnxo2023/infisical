import { z } from "zod";

import { HoneyTokenEventType, HoneyTokenType } from "./honey-token-enums";

export const AwsHoneyTokenEventMetadataSchema = z.object({
  username: z.string(),
  eventName: z.string(),
  eventSource: z.string(),
  sourceIp: z.string().optional(),
  userAgent: z.string().optional(),
  awsRegion: z.string(),
  eventTime: z.string(),
  accountId: z.string(),
  accessKeyId: z.string(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  eventId: z.string(),
  requestParameters: z.unknown().nullable()
});

export type TAwsHoneyTokenEventMetadata = z.infer<typeof AwsHoneyTokenEventMetadataSchema>;

export const HoneyTokenEventMetadataSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal(HoneyTokenEventType.AWS),
    metadata: AwsHoneyTokenEventMetadataSchema
  })
]);

export type THoneyTokenEventMetadata = z.infer<typeof HoneyTokenEventMetadataSchema>;

// --- Config schemas (typed shape for the encrypted config blob per provider) ---

export const AwsHoneyTokenConfigSchema = z.object({
  webhookSigningKey: z.string().min(1),
  stackName: z.string().min(1).max(128).default("infisical-honey-tokens")
});

export type TAwsHoneyTokenConfig = z.infer<typeof AwsHoneyTokenConfigSchema>;

export const HoneyTokenConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(HoneyTokenType.AWS),
    config: AwsHoneyTokenConfigSchema
  })
]);

export type THoneyTokenConfig = z.infer<typeof HoneyTokenConfigSchema>;
