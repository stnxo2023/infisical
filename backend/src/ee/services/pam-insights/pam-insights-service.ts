import { ForbiddenError } from "@casl/ability";
import picomatch from "picomatch";

import { ActionProjectType } from "@app/db/schemas";
import { TPamAccountDALFactory } from "@app/ee/services/pam-account/pam-account-dal";
import { TPamResourceDALFactory } from "@app/ee/services/pam-resource/pam-resource-dal";
import { TPamResourceRotationRulesDALFactory } from "@app/ee/services/pam-resource/pam-resource-rotation-rules-dal";
import { TPamSessionDALFactory } from "@app/ee/services/pam-session/pam-session-dal";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
import {
  ProjectPermissionPamInsightsActions,
  ProjectPermissionSub
} from "@app/ee/services/permission/project-permission";
import { KeyStorePrefixes, KeyStoreTtls, TKeyStoreFactory } from "@app/keystore/keystore";
import { withCache } from "@app/lib/cache/with-cache";
import { OrgServiceActor } from "@app/lib/types";

const SESSION_ACTIVITY_DAYS = 30;
const TOP_ACTORS_DAYS = 30;
const TOP_ACTORS_LIMIT = 10;
const UPCOMING_ROTATIONS_LIMIT = 100;

type TPamInsightsServiceFactoryDep = {
  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
  pamSessionDAL: Pick<TPamSessionDALFactory, "countActiveByProject" | "countDailyByProject" | "findTopActorsByProject">;
  pamResourceDAL: Pick<
    TPamResourceDALFactory,
    "countByProject" | "countWithRotationByProject" | "countByProjectGroupedByType"
  >;
  pamAccountDAL: Pick<
    TPamAccountDALFactory,
    | "countByProject"
    | "countFailedRotationsByProject"
    | "countByProjectGroupedByResourceType"
    | "findRotationCandidatesByProject"
  >;
  pamResourceRotationRulesDAL: Pick<TPamResourceRotationRulesDALFactory, "findByResourceIds">;
  keyStore: Pick<TKeyStoreFactory, "setItemWithExpiry" | "getItem">;
};

export type TPamInsightsServiceFactory = ReturnType<typeof pamInsightsServiceFactory>;

const checkPamInsightsPermission = async (
  permissionService: TPamInsightsServiceFactoryDep["permissionService"],
  projectId: string,
  actor: OrgServiceActor
) => {
  const { permission } = await permissionService.getProjectPermission({
    actor: actor.type,
    actorId: actor.id,
    projectId,
    actorAuthMethod: actor.authMethod,
    actorOrgId: actor.orgId,
    actionProjectType: ActionProjectType.PAM
  });

  ForbiddenError.from(permission).throwUnlessCan(
    ProjectPermissionPamInsightsActions.Read,
    ProjectPermissionSub.PamInsights
  );
};

const getStartOfDayUtc = (offsetDays: number): Date => {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight - offsetDays * 24 * 60 * 60 * 1000);
};

export const pamInsightsServiceFactory = ({
  permissionService,
  pamSessionDAL,
  pamResourceDAL,
  pamAccountDAL,
  pamResourceRotationRulesDAL,
  keyStore
}: TPamInsightsServiceFactoryDep) => {
  const getSummary = async (projectId: string, actor: OrgServiceActor) => {
    await checkPamInsightsPermission(permissionService, projectId, actor);

    return withCache({
      keyStore,
      key: KeyStorePrefixes.InsightsCache(projectId, "pam:summary"),
      ttlSeconds: 15,
      fetcher: async () => {
        const [
          totalResources,
          resourcesWithRotation,
          totalAccounts,
          failedRotations,
          activeSessions,
          resourceTypeCount
        ] = await Promise.all([
          pamResourceDAL.countByProject(projectId),
          pamResourceDAL.countWithRotationByProject(projectId),
          pamAccountDAL.countByProject(projectId),
          pamAccountDAL.countFailedRotationsByProject(projectId),
          pamSessionDAL.countActiveByProject(projectId),
          pamResourceDAL.countByProjectGroupedByType(projectId)
        ]);

        return {
          totalResources,
          resourcesWithRotation,
          totalAccounts,
          failedRotations,
          activeSessions,
          resourceTypeCount: resourceTypeCount.length
        };
      }
    });
  };

  const getSessionActivity = async (projectId: string, actor: OrgServiceActor) => {
    await checkPamInsightsPermission(permissionService, projectId, actor);

    return withCache({
      keyStore,
      key: KeyStorePrefixes.InsightsCache(projectId, "pam:session-activity"),
      ttlSeconds: KeyStoreTtls.InsightsCacheInSeconds,
      fetcher: async () => {
        const startDate = getStartOfDayUtc(SESSION_ACTIVITY_DAYS - 1);
        const rows = await pamSessionDAL.countDailyByProject(projectId, startDate);

        const dayCounts = new Map<string, number>();
        for (let i = SESSION_ACTIVITY_DAYS - 1; i >= 0; i -= 1) {
          const d = getStartOfDayUtc(i);
          dayCounts.set(d.toISOString().slice(0, 10), 0);
        }
        rows.forEach((row) => {
          if (dayCounts.has(row.date)) dayCounts.set(row.date, row.count);
        });

        const days = Array.from(dayCounts.entries()).map(([date, count]) => ({ date, count }));
        const total = days.reduce((sum, d) => sum + d.count, 0);
        const avgPerDay = days.length > 0 ? Math.round(total / days.length) : 0;

        return { days, avgPerDay };
      }
    });
  };

  const getTopActors = async (projectId: string, actor: OrgServiceActor) => {
    await checkPamInsightsPermission(permissionService, projectId, actor);

    return withCache({
      keyStore,
      key: KeyStorePrefixes.InsightsCache(projectId, "pam:top-actors"),
      ttlSeconds: KeyStoreTtls.InsightsCacheInSeconds,
      fetcher: async () => {
        const startDate = getStartOfDayUtc(TOP_ACTORS_DAYS - 1);
        const rows = await pamSessionDAL.findTopActorsByProject(projectId, startDate, TOP_ACTORS_LIMIT);

        return {
          actors: rows.map((row) => ({
            actorName: row.actorName,
            actorEmail: row.actorEmail,
            sessionCount: row.sessionCount,
            isService: row.userId === null
          }))
        };
      }
    });
  };

  const getResourceBreakdown = async (projectId: string, actor: OrgServiceActor) => {
    await checkPamInsightsPermission(permissionService, projectId, actor);

    return withCache({
      keyStore,
      key: KeyStorePrefixes.InsightsCache(projectId, "pam:resource-breakdown"),
      ttlSeconds: KeyStoreTtls.InsightsCacheInSeconds,
      fetcher: async () => {
        const [resourceCounts, accountCounts] = await Promise.all([
          pamResourceDAL.countByProjectGroupedByType(projectId),
          pamAccountDAL.countByProjectGroupedByResourceType(projectId)
        ]);

        const accountsByType = new Map<string, number>();
        accountCounts.forEach((row) => accountsByType.set(row.resourceType, row.count));

        const breakdown = resourceCounts.map((row) => ({
          resourceType: row.resourceType,
          resourceCount: row.count,
          accountCount: accountsByType.get(row.resourceType) ?? 0
        }));

        breakdown.sort((a, b) => b.resourceCount - a.resourceCount);

        return { breakdown };
      }
    });
  };

  const getUpcomingRotations = async (projectId: string, actor: OrgServiceActor) => {
    await checkPamInsightsPermission(permissionService, projectId, actor);

    return withCache({
      keyStore,
      key: KeyStorePrefixes.InsightsCache(projectId, "pam:upcoming-rotations"),
      ttlSeconds: KeyStoreTtls.InsightsCacheInSeconds,
      fetcher: async () => {
        const candidates = await pamAccountDAL.findRotationCandidatesByProject(projectId);
        if (!candidates.length) return { rotations: [], totalScheduled: 0 };

        const resourceIds = [...new Set(candidates.map((c) => c.resourceId))];
        const allRules = await pamResourceRotationRulesDAL.findByResourceIds(resourceIds);
        if (!allRules.length) return { rotations: [], totalScheduled: 0 };

        const rulesByResource: Record<string, typeof allRules> = {};
        for (const rule of allRules) {
          if (!rulesByResource[rule.resourceId]) rulesByResource[rule.resourceId] = [];
          rulesByResource[rule.resourceId].push(rule);
        }

        const now = Date.now();

        type TUpcomingRotation = {
          accountId: string;
          accountName: string;
          resourceId: string;
          resourceName: string;
          resourceType: string;
          intervalSeconds: number;
          nextRotationAt: Date;
        };

        // Sort by raw nextRotationMs so the most-overdue rotations stay at the top
        // even after clamping the displayed timestamp to "now" for past-due entries.
        const candidatesWithRotation: { row: TUpcomingRotation; nextRotationMs: number }[] = [];
        for (const candidate of candidates) {
          const rules = rulesByResource[candidate.resourceId];
          // eslint-disable-next-line no-continue
          if (!rules) continue;

          const matchedRule = rules.find((rule) => picomatch.isMatch(candidate.name, rule.namePattern));
          // eslint-disable-next-line no-continue
          if (!matchedRule || !matchedRule.enabled || !matchedRule.intervalSeconds) continue;

          const lastRotated = candidate.lastRotatedAt
            ? new Date(candidate.lastRotatedAt).getTime()
            : candidate.createdAt.getTime();
          const nextRotationMs = lastRotated + matchedRule.intervalSeconds * 1000;

          candidatesWithRotation.push({
            row: {
              accountId: candidate.id,
              accountName: candidate.name,
              resourceId: candidate.resourceId,
              resourceName: candidate.resourceName,
              resourceType: candidate.resourceType,
              intervalSeconds: matchedRule.intervalSeconds,
              nextRotationAt: new Date(Math.max(nextRotationMs, now))
            },
            nextRotationMs
          });
        }

        candidatesWithRotation.sort((a, b) => a.nextRotationMs - b.nextRotationMs);

        return {
          rotations: candidatesWithRotation.slice(0, UPCOMING_ROTATIONS_LIMIT).map((c) => c.row),
          totalScheduled: candidatesWithRotation.length
        };
      },
      reviver: (parsed) => {
        parsed.rotations.forEach((r) => {
          // eslint-disable-next-line no-param-reassign
          r.nextRotationAt = new Date(r.nextRotationAt);
        });
        return parsed;
      }
    });
  };

  return {
    getSummary,
    getSessionActivity,
    getTopActors,
    getResourceBreakdown,
    getUpcomingRotations
  };
};
