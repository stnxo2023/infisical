import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AsteriskIcon,
  ChevronDownIcon,
  EditIcon,
  ExternalLinkIcon,
  InfoIcon,
  SirenIcon,
  TrashIcon
} from "lucide-react";
import { twMerge } from "tailwind-merge";

import { ProjectPermissionCan } from "@app/components/permissions";
import {
  Badge,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@app/components/v3";
import { ROUTE_PATHS } from "@app/const/routes";
import {
  ProjectPermissionSecretActions,
  ProjectPermissionSub
} from "@app/context/ProjectPermissionContext/types";
import { HONEY_TOKEN_MAP } from "@app/helpers/honeyTokens";
import { useToggle } from "@app/hooks";
import { HoneyTokenStatus, HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { ResourceEnvironmentStatusCell } from "../ResourceEnvironmentStatusCell";

type Props = {
  honeyTokenName: string;
  environments: { name: string; slug: string }[];
  isHoneyTokenInEnv: (name: string, env: string) => boolean;
  getHoneyTokenByName: (slug: string, name: string) => TDashboardHoneyToken | undefined;
  tableWidth: number;
  onEdit: (honeyToken: TDashboardHoneyToken) => void;
  onDelete: (honeyToken: TDashboardHoneyToken) => void;
  onViewCredentials: (honeyToken: TDashboardHoneyToken) => void;
};

export const HoneyTokenTableRow = ({
  honeyTokenName,
  environments = [],
  isHoneyTokenInEnv,
  getHoneyTokenByName,
  tableWidth,
  onEdit,
  onDelete,
  onViewCredentials
}: Props) => {
  const navigate = useNavigate();
  const { orgId, projectId } = useParams({
    from: ROUTE_PATHS.SecretManager.OverviewPage.id
  });
  const [isExpanded, setIsExpanded] = useToggle(false);

  const isSingleEnvView = environments.length === 1;
  const totalCols = environments.length + 2;

  const singleEnvSlug = isSingleEnvView ? environments[0].slug : "";
  const singleEnvToken = isSingleEnvView
    ? getHoneyTokenByName(singleEnvSlug, honeyTokenName)
    : undefined;

  const isTriggered = environments.some((env) => {
    const ht = getHoneyTokenByName(env.slug, honeyTokenName);
    return ht?.status === HoneyTokenStatus.Triggered;
  });

  const renderActionButtons = (honeyToken: TDashboardHoneyToken) => {
    return (
      <div
        className={twMerge(
          "flex items-center rounded-md border border-border bg-container-hover px-0.5 py-0.5 shadow-md",
          "pointer-events-none opacity-0 transition-all duration-300",
          "group-hover:pointer-events-auto group-hover:gap-1 group-hover:opacity-100"
        )}
      >
        <Tooltip>
          <TooltipTrigger>
            <IconButton
              variant="ghost"
              size="xs"
              className="w-0 overflow-hidden border-0 transition-all duration-300 group-hover:w-7"
              onClick={() =>
                navigate({
                  to: ROUTE_PATHS.SecretManager.HoneyTokenDetailsByIDPage.path,
                  params: { orgId, projectId, honeyTokenId: honeyToken.id }
                })
              }
            >
              <ExternalLinkIcon />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>View details</TooltipContent>
        </Tooltip>
        <ProjectPermissionCan
          I={ProjectPermissionSecretActions.DescribeAndReadValue}
          a={ProjectPermissionSub.Secrets}
        >
          {(isAllowed) => (
            <Tooltip>
              <TooltipTrigger>
                <IconButton
                  variant="ghost"
                  size="xs"
                  className="w-0 overflow-hidden border-0 transition-all duration-300 group-hover:w-7"
                  isDisabled={!isAllowed}
                  onClick={() => onViewCredentials(honeyToken)}
                >
                  <AsteriskIcon />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>View credentials</TooltipContent>
            </Tooltip>
          )}
        </ProjectPermissionCan>
        <ProjectPermissionCan
          I={ProjectPermissionSecretActions.Edit}
          a={ProjectPermissionSub.Secrets}
          renderTooltip
          allowedLabel="Edit"
        >
          {(isAllowed) => (
            <Tooltip>
              <TooltipTrigger>
                <IconButton
                  variant="ghost"
                  size="xs"
                  className="w-0 overflow-hidden border-0 transition-all duration-300 group-hover:w-7"
                  isDisabled={!isAllowed}
                  onClick={() => onEdit(honeyToken)}
                >
                  <EditIcon />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          )}
        </ProjectPermissionCan>
        <ProjectPermissionCan
          I={ProjectPermissionSecretActions.Delete}
          a={ProjectPermissionSub.Secrets}
        >
          {(isAllowed) => (
            <Tooltip>
              <TooltipTrigger>
                <IconButton
                  variant="ghost"
                  size="xs"
                  className="w-0 overflow-hidden border-0 transition-all duration-300 group-hover:w-7 hover:text-danger"
                  onClick={() => onDelete(honeyToken)}
                  isDisabled={!isAllowed}
                >
                  <TrashIcon />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          )}
        </ProjectPermissionCan>
      </div>
    );
  };

  const renderHoneyTokenDetails = (honeyToken: TDashboardHoneyToken) => {
    const tokenInfo = HONEY_TOKEN_MAP[honeyToken.type as HoneyTokenType];
    const mappedKeys = Object.values(honeyToken.secretsMapping || {});

    return (
      <>
        {tokenInfo && (
          <Badge variant="neutral" className="mx-2.5">
            <img
              src={`/images/integrations/${tokenInfo.image}`}
              style={{ width: "11px" }}
              alt={`${tokenInfo.name} logo`}
            />
            {tokenInfo.name} Honey Token
          </Badge>
        )}
        <Badge
          variant={honeyToken.status === HoneyTokenStatus.Active ? "success" : "danger"}
          className="mx-1"
        >
          {honeyToken.status === HoneyTokenStatus.Active ? "Active" : "Triggered"}
        </Badge>
        {mappedKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <InfoIcon className="mr-2.5 !size-3 text-accent" />
            </TooltipTrigger>
            <TooltipContent>Mapped secrets: {mappedKeys.join(", ")}</TooltipContent>
          </Tooltip>
        )}
      </>
    );
  };

  return (
    <>
      <TableRow
        onClick={isSingleEnvView ? undefined : setIsExpanded.toggle}
        className="group hover:z-10"
      >
        <TableCell
          className={twMerge(
            !isSingleEnvView && "sticky left-0 z-10",
            "bg-container transition-colors duration-75 group-hover:bg-container-hover",
            !isSingleEnvView && isExpanded && "border-b-0 bg-container-hover"
          )}
        >
          {!isSingleEnvView && isExpanded ? (
            <ChevronDownIcon />
          ) : (
            <SirenIcon className={isTriggered ? "text-red" : "text-yellow"} />
          )}
        </TableCell>
        <TableCell
          className={twMerge(
            !isSingleEnvView && "sticky left-10 z-10 border-r",
            "bg-container transition-colors duration-75 group-hover:bg-container-hover",
            !isSingleEnvView && isExpanded && "border-r-0 border-b-0 bg-container-hover"
          )}
          isTruncatable
          colSpan={isSingleEnvView ? 2 : undefined}
        >
          {isSingleEnvView && singleEnvToken ? (
            <div className="relative flex w-full items-center">
              <span className="truncate">{honeyTokenName}</span>
              {renderHoneyTokenDetails(singleEnvToken)}
              <div
                className={twMerge(
                  "ml-auto flex items-center transition-[margin] duration-300",
                  "group-hover:mr-20"
                )}
              />
              <div className="absolute top-1/2 -right-2.5 z-20 -translate-y-1/2">
                {renderActionButtons(singleEnvToken)}
              </div>
            </div>
          ) : (
            <>{honeyTokenName}</>
          )}
        </TableCell>
        {environments.length > 1 &&
          environments.map(({ slug }, i) => {
            if (isExpanded) return <TableCell className="border-b-0 bg-container-hover" />;

            const isPresent = isHoneyTokenInEnv(honeyTokenName, slug);

            return (
              <ResourceEnvironmentStatusCell
                key={`ht-overview-${slug}-${i + 1}`}
                status={isPresent ? "present" : "missing"}
              />
            );
          })}
      </TableRow>
      {!isSingleEnvView && isExpanded && (
        <TableRow>
          <TableCell colSpan={totalCols} className={`${isExpanded && "bg-card p-0"}`}>
            <div
              style={{ minWidth: tableWidth, maxWidth: tableWidth }}
              className="sticky left-0 flex flex-col gap-y-4 border-t-2 border-b-1 border-l-1 border-border border-x-project/50 bg-card p-4"
            >
              <Table containerClassName="border-none rounded-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full">Environment</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environments
                    .filter((env) => {
                      const honeyToken = getHoneyTokenByName(env.slug, honeyTokenName);
                      return Boolean(honeyToken);
                    })
                    .map(({ name: envName, slug }) => {
                      const honeyToken = getHoneyTokenByName(slug, honeyTokenName)!;

                      return (
                        <TableRow key={slug} className="group relative hover:z-10">
                          <TableCell colSpan={2}>
                            <div className="relative flex w-full flex-wrap items-center">
                              <span>{envName}</span>
                              {renderHoneyTokenDetails(honeyToken)}
                              <div
                                className={twMerge(
                                  "ml-auto flex items-center transition-[margin] duration-300",
                                  "group-hover:mr-20"
                                )}
                              />
                              <div className="absolute top-1/2 -right-1.5 z-20 -translate-y-1/2">
                                {renderActionButtons(honeyToken)}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
};
