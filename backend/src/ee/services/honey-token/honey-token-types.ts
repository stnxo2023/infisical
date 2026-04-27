import { z } from "zod";

import { HoneyTokenEventType } from "./honey-token-enums";

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
