import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  AsteriskIcon,
  BanIcon,
  ExternalLinkIcon,
  InfoIcon,
  PencilIcon,
  HexagonIcon
} from "lucide-react";
import { twMerge } from "tailwind-merge";

import { ProjectPermissionCan } from "@app/components/permissions";
import { Badge, IconButton, Tooltip, TooltipContent, TooltipTrigger } from "@app/components/v3";
import { ROUTE_PATHS } from "@app/const/routes";
import { ProjectPermissionSub } from "@app/context";
import { ProjectPermissionSecretActions } from "@app/context/ProjectPermissionContext/types";
import { HONEY_TOKEN_MAP } from "@app/helpers/honeyTokens";
import { HoneyTokenStatus, HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  honeyToken: TDashboardHoneyToken;
  onEdit: () => void;
  onRevoke: () => void;
  onViewCredentials: () => void;
};

export const HoneyTokenItem = ({ honeyToken, onEdit, onRevoke, onViewCredentials }: Props) => {
  const navigate = useNavigate();
  const { orgId, projectId } = useParams({
    from: ROUTE_PATHS.SecretManager.SecretDashboardPage.id
  });
  const { name, type, status, secretsMapping } = honeyToken;
  const [isExpanded, setIsExpanded] = useState(true);

  const honeyTokenInfo = HONEY_TOKEN_MAP[type as HoneyTokenType];
  const mappedSecretKeys = Object.values(secretsMapping || {});

  const statusVariantMap: Record<string, "success" | "danger" | "neutral"> = {
    [HoneyTokenStatus.Active]: "success",
    [HoneyTokenStatus.Triggered]: "danger",
    [HoneyTokenStatus.Revoked]: "neutral"
  };

  return (
    <>
      <div
        className={twMerge(
          "group flex cursor-pointer border-b border-mineshaft-600 hover:bg-mineshaft-700"
        )}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} honey token secrets for ${name}`}
      >
        <div
          className={twMerge(
            "flex w-11 items-center py-2 pl-5",
            status === HoneyTokenStatus.Triggered && "text-red",
            status === HoneyTokenStatus.Active && "text-yellow",
            status === HoneyTokenStatus.Revoked && "text-mineshaft-400"
          )}
        >
          <HexagonIcon className="size-4" />
        </div>
        <div className="flex grow items-center py-2 pr-2 pl-4">
          <div className="flex w-full flex-wrap items-center">
            <span>{name}</span>
            {honeyTokenInfo && (
              <Badge variant="neutral" className="mx-2.5">
                <img
                  src={`/images/integrations/${honeyTokenInfo.image}`}
                  style={{ width: "11px" }}
                  alt={`${honeyTokenInfo.name} logo`}
                />
                {honeyTokenInfo.name} Honey Token
              </Badge>
            )}
            <Badge variant={statusVariantMap[status] ?? "neutral"}>
              {status === HoneyTokenStatus.Active && "Active"}
              {status === HoneyTokenStatus.Triggered && "Triggered"}
              {status === HoneyTokenStatus.Revoked && "Revoked"}
            </Badge>
          </div>
          <div
            key="actions"
            className="ml-2 flex h-full shrink-0 self-start transition-all group-hover:gap-x-2"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-4 text-mineshaft-400" />
              </TooltipTrigger>
              <TooltipContent>{mappedSecretKeys.length} mapped secret(s)</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key="options"
            className="flex w-32 items-center justify-between border-l border-mineshaft-600 px-2 py-3"
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 10, opacity: 0 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="View details"
                  variant="ghost"
                  size="xs"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({
                      to: ROUTE_PATHS.SecretManager.HoneyTokenDetailsByIDPage.path,
                      params: { orgId, projectId, honeyTokenId: honeyToken.id }
                    });
                  }}
                >
                  <ExternalLinkIcon className="size-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>View details</TooltipContent>
            </Tooltip>
            <ProjectPermissionCan
              I={ProjectPermissionSecretActions.DescribeAndReadValue}
              a={ProjectPermissionSub.Secrets}
              renderTooltip
              allowedLabel="View credentials"
            >
              {(isAllowed) => (
                <IconButton
                  aria-label="View credentials"
                  variant="ghost"
                  size="xs"
                  isDisabled={!isAllowed}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewCredentials();
                  }}
                >
                  <AsteriskIcon className="size-4" />
                </IconButton>
              )}
            </ProjectPermissionCan>
            <ProjectPermissionCan
              I={ProjectPermissionSecretActions.Edit}
              a={ProjectPermissionSub.Secrets}
              renderTooltip
              allowedLabel="Edit"
            >
              {(isAllowed) => (
                <IconButton
                  aria-label="Edit honey token"
                  variant="ghost"
                  size="xs"
                  isDisabled={!isAllowed}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                >
                  <PencilIcon className="size-4" />
                </IconButton>
              )}
            </ProjectPermissionCan>
            {status !== HoneyTokenStatus.Revoked && (
              <ProjectPermissionCan
                I={ProjectPermissionSecretActions.Delete}
                a={ProjectPermissionSub.Secrets}
                renderTooltip
                allowedLabel="Revoke"
              >
                {(isAllowed) => (
                  <IconButton
                    aria-label="Revoke honey token"
                    variant="danger"
                    size="xs"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRevoke();
                    }}
                    isDisabled={!isAllowed}
                  >
                    <BanIcon className="size-4" />
                  </IconButton>
                )}
              </ProjectPermissionCan>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      {isExpanded && (
        <div className="border-b border-mineshaft-600 bg-bunker-800">
          {mappedSecretKeys.map((secretKey) => (
            <div
              key={secretKey}
              className="flex items-center border-b border-mineshaft-700 px-5 py-2 pl-16 last:border-b-0"
            >
              <span className="font-mono text-sm text-bunker-200">{secretKey}</span>
              <Badge variant="warning" className="ml-2">
                Decoy
              </Badge>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
