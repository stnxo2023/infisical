import { z } from "zod";

import { BadRequestError } from "@app/lib/errors";

export const AwsHoneyTokenCredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string()
});

export type TAwsHoneyTokenCredentials = z.infer<typeof AwsHoneyTokenCredentialsSchema>;

export const AwsHoneyTokenDecryptedCredentialsSchema = AwsHoneyTokenCredentialsSchema.extend({
  iamUserName: z.string()
});

export type TAwsHoneyTokenDecryptedCredentials = z.infer<typeof AwsHoneyTokenDecryptedCredentialsSchema>;

export const parseAwsHoneyTokenDecryptedCredentials = (
  value: unknown
): TAwsHoneyTokenDecryptedCredentials => {
  const result = AwsHoneyTokenDecryptedCredentialsSchema.safeParse(value);

  if (!result.success) {
    throw new BadRequestError({ message: "Invalid AWS honey token credentials" });
  }

  return result.data;
};
