import { useMemo } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Skeleton
} from "@app/components/v3";
import { useProject } from "@app/context";
import { PamResourceType } from "@app/hooks/api/pam/enums";
import { PAM_RESOURCE_TYPE_MAP } from "@app/hooks/api/pam/maps";
import { useGetPamResourceBreakdown } from "@app/hooks/api/pamInsights";

const knownResourceTypes = Object.values(PamResourceType) as string[];

export const PamResourceBreakdown = () => {
  const { projectId } = useProject();
  const { data, isPending } = useGetPamResourceBreakdown({ projectId }, { enabled: !!projectId });

  const rows = useMemo(() => {
    if (!data?.breakdown) return [];
    const max = Math.max(...data.breakdown.map((r) => r.resourceCount), 1);
    return data.breakdown.map((entry) => {
      const meta = knownResourceTypes.includes(entry.resourceType)
        ? PAM_RESOURCE_TYPE_MAP[entry.resourceType as PamResourceType]
        : null;
      return {
        ...entry,
        displayName: meta?.name ?? entry.resourceType,
        image: meta?.image ?? null,
        widthPct: Math.max(2, Math.round((entry.resourceCount / max) * 100))
      };
    });
  }, [data]);

  const renderBody = () => {
    if (isPending) return <Skeleton className="h-[280px] w-full" />;
    if (!rows.length) {
      return (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle>No resources have been added yet</EmptyTitle>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <ul className="flex flex-col divide-y divide-border/60">
        {rows.map((row) => (
          <li
            key={row.resourceType}
            className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {row.image ? (
                <img
                  src={`/images/integrations/${row.image}`}
                  alt={row.displayName}
                  className="size-5 shrink-0 object-contain"
                />
              ) : (
                <span className="size-5 shrink-0 rounded-sm bg-border" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="truncate font-medium">{row.displayName}</span>
                <div className="h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-border/40">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${row.widthPct}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-baseline gap-1.5 text-sm">
              <span className="font-semibold">{row.resourceCount.toLocaleString()}</span>
              <span className="text-muted">resources</span>
              <span className="text-muted">&middot;</span>
              <span className="font-semibold">{row.accountCount.toLocaleString()}</span>
              <span className="text-muted">accounts</span>
            </div>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Resources &amp; Accounts by Type</CardTitle>
        <CardDescription>Breakdown of managed resources across integrations</CardDescription>
      </CardHeader>
      <CardContent>{renderBody()}</CardContent>
    </Card>
  );
};
