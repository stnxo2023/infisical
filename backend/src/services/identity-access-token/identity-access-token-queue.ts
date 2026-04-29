import { getConfig } from "@app/lib/config/env";
import { logger } from "@app/lib/logger";
import { QueueJobs, QueueName, TQueueServiceFactory } from "@app/queue";

import { TIdentityAccessTokenRevocationDALFactory } from "./identity-access-token-revocation-dal";

type TIdentityAccessTokenQueueServiceFactoryDep = {
  queueService: TQueueServiceFactory;
  identityAccessTokenRevocationDAL: TIdentityAccessTokenRevocationDALFactory;
};

export type TIdentityAccessTokenQueueServiceFactory = ReturnType<typeof identityAccessTokenQueueServiceFactory>;

type TRevokeTokenPayload = {
  kind: "revoke-token";
  tokenId: string;
  identityId: string;
  expiresAt: string;
};

type TRevokeAllPayload = {
  kind: "revoke-all-for-identity";
  identityId: string;
  revokedAt: string;
};

type TPgMirrorPayload = TRevokeTokenPayload | TRevokeAllPayload;

export const identityAccessTokenQueueServiceFactory = ({
  queueService,
  identityAccessTokenRevocationDAL
}: TIdentityAccessTokenQueueServiceFactoryDep) => {
  const queuePgMirror = async (payload: TPgMirrorPayload) => {
    if (payload.kind === "revoke-token") {
      await queueService.queue(
        QueueName.IdentityAccessTokenPgMirror,
        QueueJobs.IdentityAccessTokenPgMirrorRevokeToken,
        payload,
        {
          jobId: `iat-revoke-token-${payload.tokenId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 500 },
          removeOnComplete: true,
          removeOnFail: { count: 20 }
        }
      );
    } else {
      await queueService.queue(
        QueueName.IdentityAccessTokenPgMirror,
        QueueJobs.IdentityAccessTokenPgMirrorRevokeAll,
        payload,
        {
          jobId: `iat-revoke-all-${payload.identityId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 500 },
          removeOnComplete: true,
          removeOnFail: { count: 20 }
        }
      );
    }
  };

  queueService.start(QueueName.IdentityAccessTokenPgMirror, async (job) => {
    const data = job.data as TPgMirrorPayload;

    switch (data.kind) {
      case "revoke-token": {
        await identityAccessTokenRevocationDAL.insertRevocation({
          id: data.tokenId,
          identityId: data.identityId,
          expiresAt: new Date(data.expiresAt)
        });
        break;
      }
      case "revoke-all-for-identity": {
        const appCfg = getConfig();
        // expiresAt = revokedAt + MAX_AGE: every JWT issued before revokedAt
        // has its exp <= revokedAt + MAX_AGE, so the marker can be dropped
        // after that window closes.
        const revokedAt = new Date(data.revokedAt);
        await identityAccessTokenRevocationDAL.insertRevocation({
          id: data.identityId,
          identityId: data.identityId,
          revokedAt,
          expiresAt: new Date(revokedAt.getTime() + appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE * 1000)
        });
        break;
      }
      default:
        break;
    }
  });

  queueService.listen(QueueName.IdentityAccessTokenPgMirror, "failed", (_, err) => {
    logger.error(err, `${QueueName.IdentityAccessTokenPgMirror}: job failed`);
  });

  return { queuePgMirror };
};
