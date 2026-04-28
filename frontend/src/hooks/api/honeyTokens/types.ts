export enum HoneyTokenType {
  AWS = "aws"
}

export enum HoneyTokenStatus {
  Active = "active",
  Triggered = "triggered"
}

export type THoneyToken = {
  id: string;
  name: string;
  type: HoneyTokenType;
  status: HoneyTokenStatus;
  projectId: string;
  folderId: string;
  connectionId: string;
  secretsMapping: Record<string, string>;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TDashboardHoneyToken = THoneyToken & {
  environment: {
    id: string;
    name: string;
    slug: string;
  };
  folder: {
    path: string;
  };
};

export type TCreateHoneyTokenDTO = {
  projectId: string;
  type: HoneyTokenType;
  name: string;
  description?: string | null;
  secretsMapping: Record<string, string>;
  environment: string;
  secretPath: string;
};

export type TUpdateHoneyTokenDTO = {
  honeyTokenId: string;
  projectId: string;
  name?: string;
  description?: string | null;
  secretsMapping?: Record<string, string>;
};

export type TDeleteHoneyTokenDTO = {
  honeyTokenId: string;
  projectId: string;
};
