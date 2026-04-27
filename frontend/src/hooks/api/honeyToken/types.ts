export enum HoneyTokenType {
  AWS = "aws"
}

export type THoneyTokenConfig = {
  id: string | null;
  orgId: string;
  type: HoneyTokenType;
  connectionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  decryptedConfig: {
    secretToken: string;
  } | null;
};

export type TUpsertHoneyTokenConfigDTO = {
  type: HoneyTokenType;
  connectionId: string;
  config: {
    secretToken: string;
  };
};
