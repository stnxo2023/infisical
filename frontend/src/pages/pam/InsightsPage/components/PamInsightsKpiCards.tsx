import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckIcon,
  DatabaseIcon,
  InfoIcon,
  KeyRoundIcon
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton
} from "@app/components/v3";
import { cn } from "@app/components/v3/utils";
import { useOrganization, useProject } from "@app/context";
import { useGetPamInsightsSummary } from "@app/hooks/api/pamInsights";

type IconVariant = "warning" | "info" | "success" | "danger";
type FootnoteVariant = "success" | "info" | "danger";

type StatCardProps = {
  title: string;
  icon: React.ReactNode;
  iconVariant: IconVariant;
  count: number;
  subtitle: string;
  footnote: React.ReactNode;
  footnoteVariant: FootnoteVariant;
  viewLabel?: string;
  to?: string;
  params?: Record<string, string>;
};

const LiveBadge = ({ count }: { count: number }) => (
  <span className="flex animate-pulse items-center gap-1.5 rounded-full bg-green-900/40 px-2.5 py-1 text-xs font-medium text-green-400">
    <span className="size-1.5 animate-pulse rounded-full bg-green-400" />
    {count === 1 ? "1 session live" : `${count} sessions live`}
  </span>
);

const renderFootnoteIcon = (variant: FootnoteVariant) => {
  if (variant === "success") return <CheckIcon />;
  if (variant === "danger") return <AlertTriangleIcon />;
  return <InfoIcon />;
};

const computeResourcesFootnote = (totalResources: number, resourcesWithRotation: number) => {
  if (totalResources === 0) {
    return { text: "No resources yet", variant: "info" as const };
  }
  return {
    text: `${resourcesWithRotation} of ${totalResources} with rotation`,
    variant: "success" as const
  };
};

const computeAccountsFootnote = (totalAccounts: number, failedRotations: number) => {
  if (totalAccounts === 0) {
    return { text: "No accounts yet", variant: "info" as const };
  }
  if (failedRotations > 0) {
    return {
      text: `${failedRotations} failed rotation${failedRotations === 1 ? "" : "s"}`,
      variant: "danger" as const
    };
  }
  return { text: "All rotations healthy", variant: "success" as const };
};

const StatCard = ({
  title,
  icon,
  iconVariant,
  count,
  subtitle,
  footnote,
  footnoteVariant,
  viewLabel,
  to,
  params
}: StatCardProps) => {
  const navigate = useNavigate();
  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-md border [&>svg]:size-5",
              iconVariant === "info" && "border-info/15 bg-info/10 text-info",
              iconVariant === "warning" && "border-warning/15 bg-warning/10 text-warning",
              iconVariant === "success" && "border-success/15 bg-success/10 text-success",
              iconVariant === "danger" && "border-danger/15 bg-danger/10 text-danger"
            )}
          >
            {icon}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <span className="text-2xl font-semibold">{count.toLocaleString()}</span>
          <span className="ml-2 text-sm text-muted">{subtitle}</span>
        </div>
        <Separator />
        <div className="flex min-h-7 items-center justify-between">
          {typeof footnote === "string" ? (
            <Badge variant={footnoteVariant}>
              {renderFootnoteIcon(footnoteVariant)}
              {footnote}
            </Badge>
          ) : (
            footnote
          )}
          {viewLabel && to && params && (
            <Button
              variant="outline"
              size="xs"
              disabled={count === 0}
              onClick={() => navigate({ to, params })}
            >
              {viewLabel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const PamInsightsKpiCards = () => {
  const { currentOrg } = useOrganization();
  const { projectId } = useProject();
  const { data, isPending } = useGetPamInsightsSummary({ projectId }, { enabled: !!projectId });
  const params = { orgId: currentOrg.id, projectId };

  if (isPending) {
    return (
      <div className="flex flex-col gap-6 xl:flex-row">
        <Skeleton className="h-[183px] flex-1" />
        <Skeleton className="h-[183px] flex-1" />
        <Skeleton className="h-[183px] flex-1" />
      </div>
    );
  }

  const totalResources = data?.totalResources ?? 0;
  const resourcesWithRotation = data?.resourcesWithRotation ?? 0;
  const totalAccounts = data?.totalAccounts ?? 0;
  const failedRotations = data?.failedRotations ?? 0;
  const activeSessions = data?.activeSessions ?? 0;
  const resourceTypeCount = data?.resourceTypeCount ?? 0;

  const resourcesFootnote = computeResourcesFootnote(totalResources, resourcesWithRotation);
  const accountsFootnote = computeAccountsFootnote(totalAccounts, failedRotations);

  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      <StatCard
        title="Total Resources"
        icon={<DatabaseIcon />}
        iconVariant="info"
        count={totalResources}
        subtitle={`Across ${resourceTypeCount} resource types`}
        footnote={resourcesFootnote.text}
        footnoteVariant={resourcesFootnote.variant}
        viewLabel="View Resources"
        to="/organizations/$orgId/projects/pam/$projectId/resources"
        params={params}
      />
      <StatCard
        title="Total Accounts"
        icon={<KeyRoundIcon />}
        iconVariant="warning"
        count={totalAccounts}
        subtitle="Privileged credentials"
        footnote={accountsFootnote.text}
        footnoteVariant={accountsFootnote.variant}
      />
      <StatCard
        title="Active Sessions"
        icon={<ActivityIcon />}
        iconVariant="success"
        count={activeSessions}
        subtitle="Currently live"
        footnote={activeSessions > 0 ? <LiveBadge count={activeSessions} /> : "No active sessions"}
        footnoteVariant="info"
        viewLabel="View Sessions"
        to="/organizations/$orgId/projects/pam/$projectId/sessions"
        params={params}
      />
    </div>
  );
};
