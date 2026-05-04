import { TLicenseServiceFactory } from "@app/ee/services/license/license-service";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { TFolderCommitServiceFactory } from "@app/services/folder-commit/folder-commit-service";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { TOrgDALFactory } from "@app/services/org/org-dal";
import { TProjectDALFactory } from "@app/services/project/project-dal";
import { TProjectBotServiceFactory } from "@app/services/project-bot/project-bot-service";
import { TResourceMetadataDALFactory } from "@app/services/resource-metadata/resource-metadata-dal";
import { TSecretQueueFactory } from "@app/services/secret/secret-queue";
import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
import { TSecretTagDALFactory } from "@app/services/secret-tag/secret-tag-dal";
import { TSecretV2BridgeDALFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-dal";
import { TSecretVersionV2DALFactory } from "@app/services/secret-v2-bridge/secret-version-dal";
import { TSecretVersionV2TagDALFactory } from "@app/services/secret-v2-bridge/secret-version-tag-dal";
import { TSmtpService } from "@app/services/smtp/smtp-service";

import { TSecretSnapshotServiceFactory } from "../secret-snapshot/secret-snapshot-service";
import { THoneyTokenConfigDALFactory } from "./honey-token-config-dal";
import { THoneyTokenDALFactory } from "./honey-token-dal";
import { THoneyTokenEventDALFactory } from "./honey-token-event-dal";

export type THoneyTokenServiceFactoryDep = {
  honeyTokenDAL: THoneyTokenDALFactory;
  honeyTokenConfigDAL: THoneyTokenConfigDALFactory;
  honeyTokenEventDAL: Pick<
    THoneyTokenEventDALFactory,
    "create" | "find" | "countByHoneyTokenId" | "findByHoneyTokenId"
  >;
  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
  licenseService: Pick<TLicenseServiceFactory, "getPlan">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  orgDAL: Pick<TOrgDALFactory, "findOrgMembersByRole">;
  projectDAL: Pick<TProjectDALFactory, "findById">;
  smtpService: Pick<TSmtpService, "sendMail">;
  folderDAL: Pick<
    TSecretFolderDALFactory,
    "findBySecretPath" | "findBySecretPathMultiEnv" | "findSecretPathByFolderIds"
  >;
  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
  secretDAL: Pick<
    TSecretV2BridgeDALFactory,
    "insertMany" | "upsertSecretReferences" | "find" | "deleteMany" | "invalidateSecretCacheByProjectId"
  >;
  secretVersionDAL: Pick<TSecretVersionV2DALFactory, "insertMany" | "findLatestVersionMany">;
  secretVersionTagDAL: Pick<TSecretVersionV2TagDALFactory, "insertMany">;
  secretTagDAL: TSecretTagDALFactory;
  folderCommitService: Pick<TFolderCommitServiceFactory, "createCommit">;
  resourceMetadataDAL: Pick<TResourceMetadataDALFactory, "insertMany">;
  snapshotService: Pick<TSecretSnapshotServiceFactory, "performSnapshot">;
  secretQueueService: Pick<TSecretQueueFactory, "syncSecrets" | "removeSecretReminder">;
};
