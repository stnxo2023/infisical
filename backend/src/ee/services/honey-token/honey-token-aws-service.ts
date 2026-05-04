import { KmsDataKey } from "@app/services/kms/kms-types";

import {
  createAwsIamHoneyTokenCredentials,
  revokeAwsIamHoneyTokenCredentials,
  verifyAwsStackDeployment
} from "./honey-token-aws-service-helpers";
import { parseAwsHoneyTokenDecryptedCredentials } from "./honey-token-aws-types";
import { THoneyTokenProviderHooks } from "./honey-token-provider-hook-types";
import { THoneyTokenServiceFactoryDep } from "./honey-token-service-types";
import { AwsHoneyTokenConfigSchema } from "./honey-token-types";

type THoneyTokenAwsProviderHookFactoryDep = Pick<THoneyTokenServiceFactoryDep, "kmsService" | "appConnectionDAL">;

export const honeyTokenAwsProviderHooksFactory = ({
  kmsService,
  appConnectionDAL
}: THoneyTokenAwsProviderHookFactoryDep): THoneyTokenProviderHooks => ({
  createCredentials: (appConnection) =>
    createAwsIamHoneyTokenCredentials({
      appConnection,
      kmsService
    }).then((credentials) => ({
      credentials,
      tokenIdentifier: credentials.accessKeyId
    })),
  revokeCredentials: ({ appConnection, credentials }) =>
    revokeAwsIamHoneyTokenCredentials({
      appConnection,
      kmsService,
      iamUserName: credentials.iamUserName,
      accessKeyId: credentials.accessKeyId
    }),
  verifyDeployment: async ({ connectionId, orgId, encryptedConfig }) => {
    const { decryptor: configDecryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId
    });
    const stackName = encryptedConfig
      ? AwsHoneyTokenConfigSchema.parse(
          JSON.parse(configDecryptor({ cipherTextBlob: encryptedConfig }).toString()) as unknown
        ).stackName
      : "infisical-honey-tokens";

    return verifyAwsStackDeployment({
      connectionId,
      stackName,
      appConnectionDAL,
      kmsService
    });
  },
  getCredentialsForDisplay: async ({ encryptedCredentials, orgId }) => {
    const { decryptor } = await kmsService.createCipherPairWithDataKey({
      type: KmsDataKey.Organization,
      orgId
    });
    const decryptedCredentials = parseAwsHoneyTokenDecryptedCredentials(
      JSON.parse(decryptor({ cipherTextBlob: encryptedCredentials }).toString()) as unknown
    );
    return {
      accessKeyId: decryptedCredentials.accessKeyId,
      secretAccessKey: decryptedCredentials.secretAccessKey
    };
  }
});
