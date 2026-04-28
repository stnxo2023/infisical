import { HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";

export { HoneyTokenType };

export type THoneyTokenConfig = {
  id: string | null;
  orgId: string;
  type: HoneyTokenType;
  connectionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  decryptedConfig: {
    webhookSigningKey: string;
  } | null;
};

export type TUpsertHoneyTokenConfigDTO = {
  type: HoneyTokenType;
  connectionId: string;
  config: {
    webhookSigningKey: string;
  };
};
