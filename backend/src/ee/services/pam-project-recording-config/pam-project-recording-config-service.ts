import { ForbiddenError } from "@casl/ability";

import { ActionProjectType } from "@app/db/schemas";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
import { ProjectPermissionActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
import { BadRequestError, NotFoundError } from "@app/lib/errors";
import { OrgServiceActor } from "@app/lib/types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { AppConnection, AWSRegion } from "@app/services/app-connection/app-connection-enums";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { TAppConnectionServiceFactory } from "@app/services/app-connection/app-connection-service";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-fns";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { ActorType } from "@app/services/auth/auth-type";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";

import { PamRecordingStorageBackend } from "../pam-session-recording-storage/pam-session-recording-storage-enums";
import { PAM_RECORDING_STORAGE_FACTORY_MAP } from "../pam-session-recording-storage/pam-session-recording-storage-factory";
import { TPamRecordingResolvedConfig } from "../pam-session-recording-storage/pam-session-recording-storage-types";
import { TPamProjectRecordingConfigDALFactory } from "./pam-project-recording-config-dal";
import {
  TDeletePamRecordingConfigDTO,
  TGetPamRecordingConfigDTO,
  TUpsertPamRecordingConfigDTO
} from "./pam-project-recording-config-types";

type TPamProjectRecordingConfigServiceFactoryDep = {
  pamProjectRecordingConfigDAL: TPamProjectRecordingConfigDALFactory;
  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
  appConnectionService: Pick<TAppConnectionServiceFactory, "findAppConnectionById">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
};

export type TPamProjectRecordingConfigServiceFactory = ReturnType<typeof pamProjectRecordingConfigServiceFactory>;

export const pamProjectRecordingConfigServiceFactory = ({
  pamProjectRecordingConfigDAL,
  permissionService,
  appConnectionService,
  appConnectionDAL,
  kmsService
}: TPamProjectRecordingConfigServiceFactoryDep) => {
  // Gateways: direct DAL lookup (getOrgPermission doesn't support GATEWAY actors).
  // Users: permission-checked lookup via appConnectionService for playback.
  const resolveConfigForProject = async (
    projectId: string,
    actor: OrgServiceActor
  ): Promise<TPamRecordingResolvedConfig | null> => {
    const row = await pamProjectRecordingConfigDAL.findByProjectId(projectId);
    if (!row) return null;

    if (row.storageBackend === PamRecordingStorageBackend.AwsS3) {
      let appConnection;
      if (actor.type === ActorType.GATEWAY) {
        const raw = await appConnectionDAL.findById(row.connectionId);
        if (!raw) throw new NotFoundError({ message: `AWS app connection ${row.connectionId} not found` });
        appConnection = await decryptAppConnection(raw, kmsService);
      } else {
        appConnection = await appConnectionService.findAppConnectionById(AppConnection.AWS, row.connectionId, actor);
      }

      const awsConfig = await getAwsConnectionConfig(
        appConnection as unknown as TAwsConnectionConfig,
        row.region as never
      );

      return {
        backend: PamRecordingStorageBackend.AwsS3,
        bucket: row.bucket,
        region: row.region as AWSRegion,
        keyPrefix: row.keyPrefix ?? null,
        awsCredentials: awsConfig.credentials
      };
    }

    return {
      backend: PamRecordingStorageBackend.Postgres,
      keyPrefix: row.keyPrefix ?? null
    };
  };

  const getConfig = async ({ projectId }: TGetPamRecordingConfigDTO, actor: OrgServiceActor) => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorAuthMethod: actor.authMethod,
      actorId: actor.id,
      actorOrgId: actor.orgId,
      projectId,
      actionProjectType: ActionProjectType.PAM
    });
    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionActions.Read, ProjectPermissionSub.Settings);

    const row = await pamProjectRecordingConfigDAL.findByProjectId(projectId);
    return { config: row ?? null };
  };

  const testConfig = async (input: TUpsertPamRecordingConfigDTO, actor: OrgServiceActor) => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorAuthMethod: actor.authMethod,
      actorId: actor.id,
      actorOrgId: actor.orgId,
      projectId: input.projectId,
      actionProjectType: ActionProjectType.PAM
    });
    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionActions.Edit, ProjectPermissionSub.Settings);

    if (input.storageBackend !== PamRecordingStorageBackend.AwsS3) {
      throw new BadRequestError({ message: `Unsupported storage backend: ${input.storageBackend}` });
    }

    const appConnection = await appConnectionService.findAppConnectionById(
      AppConnection.AWS,
      input.connectionId,
      actor
    );
    if (!appConnection) throw new NotFoundError({ message: `AWS app connection ${input.connectionId} not found` });

    const awsConfig = await getAwsConnectionConfig(
      appConnection as unknown as TAwsConnectionConfig,
      input.region as never
    );

    const provider = PAM_RECORDING_STORAGE_FACTORY_MAP[input.storageBackend]();
    await provider.validateConfig({
      config: {
        backend: PamRecordingStorageBackend.AwsS3,
        bucket: input.bucket,
        region: input.region,
        keyPrefix: input.keyPrefix ?? null,
        awsCredentials: awsConfig.credentials
      }
    });

    return { ok: true as const };
  };

  const upsertConfig = async (input: TUpsertPamRecordingConfigDTO, actor: OrgServiceActor) => {
    await testConfig(input, actor);

    const existing = await pamProjectRecordingConfigDAL.findByProjectId(input.projectId);
    if (existing) {
      const updated = await pamProjectRecordingConfigDAL.updateById(existing.id, {
        storageBackend: input.storageBackend,
        connectionId: input.connectionId,
        bucket: input.bucket,
        region: input.region,
        keyPrefix: input.keyPrefix ?? null
      });
      return { config: updated };
    }

    const created = await pamProjectRecordingConfigDAL.create({
      projectId: input.projectId,
      storageBackend: input.storageBackend,
      connectionId: input.connectionId,
      bucket: input.bucket,
      region: input.region,
      keyPrefix: input.keyPrefix ?? null
    });
    return { config: created };
  };

  const deleteConfig = async ({ projectId }: TDeletePamRecordingConfigDTO, actor: OrgServiceActor) => {
    const { permission } = await permissionService.getProjectPermission({
      actor: actor.type,
      actorAuthMethod: actor.authMethod,
      actorId: actor.id,
      actorOrgId: actor.orgId,
      projectId,
      actionProjectType: ActionProjectType.PAM
    });
    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionActions.Edit, ProjectPermissionSub.Settings);

    const existing = await pamProjectRecordingConfigDAL.findByProjectId(projectId);
    if (!existing) return { ok: true as const };
    await pamProjectRecordingConfigDAL.deleteById(existing.id);
    return { ok: true as const };
  };

  return {
    getConfig,
    upsertConfig,
    deleteConfig,
    resolveConfigForProject
  };
};
