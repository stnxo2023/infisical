import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  IAMClient
} from "@aws-sdk/client-iam";

import { crypto } from "@app/lib/crypto/cryptography";
import { BadRequestError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws";
import { AwsConnectionSchema } from "@app/services/app-connection/aws/aws-connection-schemas";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";

type TEncryptedAppConnection = Parameters<typeof decryptAppConnection>[0];

const HONEY_TOKEN_IAM_USER_PREFIX = "inf_ht_";
const CF_COMPLETE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);

const parseAwsConnectionConfig = (decryptedConnection: unknown): TAwsConnectionConfig => {
  const parsedConnection = AwsConnectionSchema.safeParse(decryptedConnection);
  if (!parsedConnection.success) {
    throw new BadRequestError({
      message: "Invalid AWS App Connection configuration"
    });
  }

  return parsedConnection.data as TAwsConnectionConfig;
};

export const verifyAwsStackDeployment = async ({
  connectionId,
  stackName,
  appConnectionDAL,
  kmsService
}: {
  connectionId: string;
  stackName: string;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
}): Promise<{ deployed: boolean; status: string | null }> => {
  try {
    const appConnection = await appConnectionDAL.findById(connectionId);
    if (!appConnection) return { deployed: false, status: null };

    const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
    const awsConfig = parseAwsConnectionConfig(decryptedConnection);
    const { credentials: awsCredentials } = await getAwsConnectionConfig(awsConfig);

    const cfn = new CloudFormationClient({ credentials: awsCredentials, region: "us-east-1" });
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];

    if (!stack) return { deployed: false, status: null };

    return {
      deployed: CF_COMPLETE_STATUSES.has(stack.StackStatus ?? ""),
      status: stack.StackStatus ?? null
    };
  } catch (err) {
    const awsCode = (err as { code?: string }).code;

    if (awsCode === "ValidationError") {
      return { deployed: false, status: null };
    }

    logger.warn({ err, connectionId, stackName }, "Failed to verify honey token CloudFormation stack deployment");
    return { deployed: false, status: null };
  }
};

export const createAwsIamHoneyTokenCredentials = async ({
  appConnection,
  kmsService
}: {
  appConnection: TEncryptedAppConnection;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
}) => {
  const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
  const awsConfig = parseAwsConnectionConfig(decryptedConnection);
  const { credentials: awsCredentials, region } = await getAwsConnectionConfig(awsConfig);
  const iam = new IAMClient({ credentials: awsCredentials, region });

  const iamUserName = `${HONEY_TOKEN_IAM_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  await iam.send(new CreateUserCommand({ UserName: iamUserName }));

  const createKeyRes = await iam.send(new CreateAccessKeyCommand({ UserName: iamUserName }));
  if (!createKeyRes.AccessKey?.AccessKeyId || !createKeyRes.AccessKey?.SecretAccessKey) {
    throw new BadRequestError({ message: "Failed to create AWS access key for honey token" });
  }

  return {
    accessKeyId: createKeyRes.AccessKey.AccessKeyId,
    secretAccessKey: createKeyRes.AccessKey.SecretAccessKey,
    iamUserName
  };
};

export const revokeAwsIamHoneyTokenCredentials = async ({
  appConnection,
  kmsService,
  iamUserName,
  accessKeyId
}: {
  appConnection: TEncryptedAppConnection;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  iamUserName: string;
  accessKeyId: string;
}) => {
  const decryptedConnection = await decryptAppConnection(appConnection, kmsService);
  const awsConfig = parseAwsConnectionConfig(decryptedConnection);
  const { credentials: awsCredentials, region } = await getAwsConnectionConfig(awsConfig);
  const iam = new IAMClient({ credentials: awsCredentials, region });

  try {
    await iam.send(
      new DeleteAccessKeyCommand({
        UserName: iamUserName,
        AccessKeyId: accessKeyId
      })
    );
  } catch (err) {
    logger.info(
      { err, iamUserName, accessKeyId },
      "Skipping AWS access key deletion for honey token because it may already be deleted"
    );
  }

  try {
    await iam.send(new DeleteUserCommand({ UserName: iamUserName }));
  } catch (err) {
    logger.info(
      { err, iamUserName, accessKeyId },
      "Skipping AWS IAM user deletion for honey token because it may already be deleted"
    );
  }
};
