import { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";

export type THoneyTokenAppConnection = NonNullable<
  Awaited<ReturnType<THoneyTokenServiceFactoryDep["appConnectionDAL"]["findById"]>>
>;

export type THoneyTokenDeploymentStatus = { deployed: boolean; status: string | null };

export type THoneyTokenProviderHooks = {
  createCredentials: (appConnection: THoneyTokenAppConnection) => Promise<{
    credentials: Record<string, string>;
    tokenIdentifier: string;
  }>;
  revokeCredentials: (input: {
    appConnection: THoneyTokenAppConnection;
    credentials: Record<string, string>;
  }) => Promise<void>;
  verifyDeployment?: (input: {
    appConnection: THoneyTokenAppConnection;
    orgId: string;
    encryptedConfig?: Buffer | null;
    connectionId: string;
  }) => Promise<THoneyTokenDeploymentStatus>;
  getCredentialsForDisplay: (input: { encryptedCredentials: Buffer; orgId: string }) => Promise<Record<string, string>>;
};
