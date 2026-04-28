import { useState } from "react";
import { faAsterisk, faEdit, faInfoCircle, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { SirenIcon } from "lucide-react";
import { twMerge } from "tailwind-merge";

import { ProjectPermissionCan } from "@app/components/permissions";
import { IconButton, Tag, Tooltip } from "@app/components/v2";
import { ProjectPermissionSub } from "@app/context";
import { ProjectPermissionSecretActions } from "@app/context/ProjectPermissionContext/types";
import { HONEY_TOKEN_MAP } from "@app/helpers/honeyTokens";
import { HoneyTokenStatus, HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  honeyToken: TDashboardHoneyToken;
  onEdit: () => void;
  onDelete: () => void;
  onViewCredentials: () => void;
};

export const HoneyTokenItem = ({ honeyToken, onEdit, onDelete, onViewCredentials }: Props) => {
  const { name, type, status, secretsMapping } = honeyToken;
  const [isExpanded, setIsExpanded] = useState(true);

  const honeyTokenInfo = HONEY_TOKEN_MAP[type as HoneyTokenType];
  const mappedSecretKeys = Object.values(secretsMapping || {});

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
            status === HoneyTokenStatus.Triggered ? "text-red" : "text-yellow"
          )}
        >
          <SirenIcon className="size-4" />
        </div>
        <div className="flex grow items-center py-2 pr-2 pl-4">
          <div className="flex w-full flex-wrap items-center">
            <span>{name}</span>
            {honeyTokenInfo && (
              <Tag className="mx-2.5 flex items-center gap-1 px-1.5 py-0 text-xs normal-case">
                <img
                  src={`/images/integrations/${honeyTokenInfo.image}`}
                  style={{ width: "11px" }}
                  alt={`${honeyTokenInfo.name} logo`}
                />
                {honeyTokenInfo.name} Honey Token
              </Tag>
            )}
            <Tag
              className={twMerge(
                "px-1.5 py-0 text-xs normal-case",
                status === HoneyTokenStatus.Active ? "bg-green/20 text-green" : "bg-red/20 text-red"
              )}
            >
              {status === HoneyTokenStatus.Active ? "Active" : "Triggered"}
            </Tag>
          </div>
          <div
            key="actions"
            className="ml-2 flex h-full shrink-0 self-start transition-all group-hover:gap-x-2"
          >
            <Tooltip content={`${mappedSecretKeys.length} mapped secret(s)`}>
              <FontAwesomeIcon icon={faInfoCircle} className="text-mineshaft-400" />
            </Tooltip>
          </div>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key="options"
            className="flex w-24 items-center justify-between border-l border-mineshaft-600 px-2 py-3"
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 10, opacity: 0 }}
          >
            <ProjectPermissionCan
              I={ProjectPermissionSecretActions.DescribeAndReadValue}
              a={ProjectPermissionSub.Secrets}
              renderTooltip
              allowedLabel="View credentials"
            >
              {(isAllowed) => (
                <IconButton
                  ariaLabel="View credentials"
                  variant="plain"
                  isDisabled={!isAllowed}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewCredentials();
                  }}
                >
                  <FontAwesomeIcon icon={faAsterisk} />
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
                  ariaLabel="Edit honey token"
                  variant="plain"
                  isDisabled={!isAllowed}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                >
                  <FontAwesomeIcon icon={faEdit} />
                </IconButton>
              )}
            </ProjectPermissionCan>
            <ProjectPermissionCan
              I={ProjectPermissionSecretActions.Delete}
              a={ProjectPermissionSub.Secrets}
              renderTooltip
              allowedLabel="Delete"
            >
              {(isAllowed) => (
                <IconButton
                  ariaLabel="Delete honey token"
                  variant="plain"
                  colorSchema="danger"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  isDisabled={!isAllowed}
                >
                  <FontAwesomeIcon icon={faTrash} />
                </IconButton>
              )}
            </ProjectPermissionCan>
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
              <Tag className="ml-2 px-1.5 py-0 text-xs text-yellow normal-case">Decoy</Tag>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
