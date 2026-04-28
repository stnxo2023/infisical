import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow, parseISO } from "date-fns";
import { ExternalLinkIcon } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@app/components/v3";
import { useOrganization, useProject } from "@app/context";
import { PamResourceType } from "@app/hooks/api/pam/enums";
import { PAM_RESOURCE_TYPE_MAP } from "@app/hooks/api/pam/maps";
import { useGetPamUpcomingRotations } from "@app/hooks/api/pamInsights";

const knownResourceTypes = Object.values(PamResourceType) as string[];

const accountRoute =
  "/organizations/$orgId/projects/pam/$projectId/resources/$resourceType/$resourceId/accounts/$accountId" as const;

export const PamUpcomingRotations = () => {
  const { currentOrg } = useOrganization();
  const { projectId } = useProject();
  const { data, isPending } = useGetPamUpcomingRotations({ projectId }, { enabled: !!projectId });
  const navigate = useNavigate();

  const rows = useMemo(() => {
    if (!data?.rotations) return [];
    return data.rotations.map((r) => {
      const meta = knownResourceTypes.includes(r.resourceType)
        ? PAM_RESOURCE_TYPE_MAP[r.resourceType as PamResourceType]
        : null;
      return {
        ...r,
        displayType: meta?.name ?? r.resourceType,
        image: meta?.image ?? null
      };
    });
  }, [data]);

  const renderBody = () => {
    if (isPending) return <Skeleton className="h-[280px] w-full" />;
    if (!rows.length) {
      return (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle>No rotations scheduled</EmptyTitle>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <Table containerClassName="max-h-72">
        <TableHeader className="sticky top-0 z-10 bg-container shadow-[inset_0_-1px_0_var(--color-border)]">
          <TableRow>
            <TableHead>Resource</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Next Rotation</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.accountId}
              onClick={() =>
                navigate({
                  to: accountRoute,
                  params: {
                    orgId: currentOrg.id,
                    projectId,
                    resourceType: row.resourceType,
                    resourceId: row.resourceId,
                    accountId: row.accountId
                  }
                })
              }
            >
              <TableCell className="max-w-[140px] truncate font-medium" title={row.resourceName}>
                {row.resourceName}
              </TableCell>
              <TableCell className="max-w-[120px] truncate text-muted" title={row.accountName}>
                {row.accountName}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  {row.image && (
                    <img
                      src={`/images/integrations/${row.image}`}
                      alt={row.displayType}
                      className="size-3.5 shrink-0 object-contain"
                    />
                  )}
                  <span className="text-xs text-muted">{row.displayType}</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="warning">
                  {formatDistanceToNow(parseISO(row.nextRotationAt), { addSuffix: true })}
                </Badge>
              </TableCell>
              <TableCell className="w-8 px-2">
                <ExternalLinkIcon className="size-3.5 text-muted" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Account credentials due to rotate</CardTitle>
        <CardDescription>
          {data?.totalScheduled ?? 0} scheduled rotation
          {data?.totalScheduled === 1 ? "" : "s"} across this project
        </CardDescription>
      </CardHeader>
      <CardContent>{renderBody()}</CardContent>
    </Card>
  );
};
