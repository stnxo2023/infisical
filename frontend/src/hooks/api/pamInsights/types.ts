export type TGetPamInsightsParams = {
  projectId: string;
};

export type TPamInsightsSummary = {
  totalResources: number;
  resourcesWithRotation: number;
  totalAccounts: number;
  failedRotations: number;
  activeSessions: number;
  resourceTypeCount: number;
};

export type TPamSessionActivityDay = {
  date: string;
  count: number;
};

export type TPamSessionActivityResponse = {
  days: TPamSessionActivityDay[];
  avgPerDay: number;
};

export type TPamTopActor = {
  actorName: string;
  actorEmail: string;
  sessionCount: number;
  isService: boolean;
};

export type TPamTopActorsResponse = {
  actors: TPamTopActor[];
};

export type TPamResourceBreakdownEntry = {
  resourceType: string;
  resourceCount: number;
  accountCount: number;
};

export type TPamResourceBreakdownResponse = {
  breakdown: TPamResourceBreakdownEntry[];
};

export type TPamUpcomingRotation = {
  accountId: string;
  accountName: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  intervalSeconds: number;
  nextRotationAt: string;
};

export type TPamUpcomingRotationsResponse = {
  rotations: TPamUpcomingRotation[];
  totalScheduled: number;
};
