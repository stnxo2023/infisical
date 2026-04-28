import { AppConnection } from "@app/hooks/api/appConnections/enums";
import { HoneyTokenStatus } from "@app/hooks/api/honeyTokens/enums";

export type THoneyTokenBase = {
  id: string;
  name: string;
  description?: string | null;
  status: HoneyTokenStatus;
  projectId: string;
  folderId: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
};

export type TDashboardHoneyTokenBase = THoneyTokenBase & {
  environment: {
    id: string;
    name: string;
    slug: string;
  };
  folder: {
    path: string;
  };
};

export type THoneyTokenOptionBase<U, T extends AppConnection> = {
  name: string;
  type: U;
  connection: T;
  template: {
    secretsMapping: Record<string, string>;
  };
};

export type THoneyTokenCredentialsResponseBase<U, T> = {
  type: U;
  honeyTokenId: string;
  credentials: T;
};
