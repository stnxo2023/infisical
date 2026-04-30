import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useNavigate, useParams } from "@tanstack/react-router";
import { format, formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  BanIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ClockIcon,
  KeyIcon,
  MapPinIcon,
  RotateCcw,
  HexagonIcon
} from "lucide-react";
import { twMerge } from "tailwind-merge";

import { createNotification } from "@app/components/notifications";
import { ProjectPermissionCan } from "@app/components/permissions";
import { CredentialDisplay } from "@app/components/secret-rotations-v2/ViewSecretRotationV2GeneratedCredentials/shared/CredentialDisplay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Badge,
  Button,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldContent,
  FieldLabel,
  Input,
  PageLoader,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@app/components/v3";
import { ROUTE_PATHS } from "@app/const/routes";
import { ProjectPermissionSub } from "@app/context";
import { ProjectPermissionSecretActions } from "@app/context/ProjectPermissionContext/types";
import { HONEY_TOKEN_CREDENTIAL_FIELDS, HONEY_TOKEN_MAP } from "@app/helpers/honeyTokens";
import { HoneyTokenStatus, HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";
import { useResetHoneyToken, useRevokeHoneyToken } from "@app/hooks/api/honeyTokens/mutations";
import {
  useGetHoneyTokenById,
  useGetHoneyTokenCredentials
} from "@app/hooks/api/honeyTokens/queries";

import { HoneyTokenEventsSection } from "./components";

const PageContent = () => {
  const navigate = useNavigate();
  const { honeyTokenId, projectId, orgId } = useParams({
    from: ROUTE_PATHS.SecretManager.HoneyTokenDetailsByIDPage.id
  });

  const { data: honeyToken, isPending } = useGetHoneyTokenById({
    honeyTokenId,
    projectId,
    enabled: Boolean(honeyTokenId && projectId)
  });

  const { mutateAsync: resetHoneyToken } = useResetHoneyToken();
  const { mutateAsync: revokeHoneyToken } = useRevokeHoneyToken();
  const [isRevokeOpen, setIsRevokeOpen] = useState(false);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [revokeInput, setRevokeInput] = useState("");
  const { data: credentials, isPending: isCredentialsPending } = useGetHoneyTokenCredentials({
    honeyTokenId,
    projectId,
    enabled: Boolean(honeyTokenId && projectId)
  });

  useEffect(() => {
    setRevokeInput("");
  }, [isRevokeOpen]);

  if (isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <PageLoader />
      </div>
    );
  }

  if (!honeyToken) {
    return (
      <div className="flex h-full w-full items-center justify-center px-20">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Could not find honey token with ID {honeyTokenId}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const isTriggered = honeyToken.status === HoneyTokenStatus.Triggered;
  const isRevoked = honeyToken.status === HoneyTokenStatus.Revoked;
  const tokenInfo = HONEY_TOKEN_MAP[honeyToken.type as HoneyTokenType];

  let statusBadgeVariant: "danger" | "neutral" | "success" = "success";
  let statusLabel = "Active";
  if (isTriggered) {
    statusBadgeVariant = "danger";
    statusLabel = "Triggered";
  } else if (isRevoked) {
    statusBadgeVariant = "neutral";
    statusLabel = "Revoked";
  }

  const handleReset = async () => {
    await resetHoneyToken({
      honeyTokenId: honeyToken.id,
      projectId
    });
    createNotification({
      text: `Honey token "${honeyToken.name}" has been reset`,
      type: "success"
    });
  };

  const handleRevoke = async () => {
    await revokeHoneyToken({
      honeyTokenId: honeyToken.id,
      projectId
    });
    createNotification({
      text: `Successfully revoked honey token "${honeyToken.name}"`,
      type: "success"
    });
  };

  return (
    <>
      <Helmet>
        <title>{honeyToken.name} | Honey Token</title>
      </Helmet>
      <div className="container mx-auto flex flex-col justify-between bg-bunker-800 font-inter text-white">
        <div className="mx-auto mb-6 w-full max-w-8xl">
          <Button
            variant="ghost"
            onClick={() => {
              navigate({
                to: ROUTE_PATHS.SecretManager.OverviewPage.path,
                params: { orgId, projectId }
              });
            }}
          >
            <ChevronLeftIcon size={14} />
            Overview
          </Button>

          <div className="mt-2 mb-4 rounded-lg border border-mineshaft-600 bg-mineshaft-900 p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-mineshaft-600 bg-mineshaft-800">
                  <HexagonIcon
                    className={twMerge(
                      isTriggered && "text-red-500",
                      isRevoked && "text-mineshaft-400",
                      !isTriggered && !isRevoked && "text-yellow-500"
                    )}
                    size={22}
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <p className="truncate text-lg font-medium text-white">{honeyToken.name}</p>
                    <Badge variant={statusBadgeVariant}>
                      {isTriggered && <AlertTriangle size={12} className="mr-1" />}
                      {statusLabel}
                    </Badge>
                    {tokenInfo && (
                      <Badge variant="neutral" className="flex items-center gap-1">
                        <img
                          src={`/images/integrations/${tokenInfo.image}`}
                          style={{ width: "11px" }}
                          alt={`${tokenInfo.name} logo`}
                        />
                        {tokenInfo.name}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-bunker-300">
                    {honeyToken.description || `${tokenInfo?.name ?? "Honey"} Token`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isTriggered && (
                  <Button variant="outline" size="xs" onClick={() => setIsResetOpen(true)}>
                    <RotateCcw size={14} />
                    Reset
                  </Button>
                )}
                {!isRevoked && (
                  <Button variant="danger" size="xs" onClick={() => setIsRevokeOpen(true)}>
                    <BanIcon size={14} />
                    Revoke
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-mineshaft-600 pt-4 text-xs text-bunker-300">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5">
                    <CalendarIcon size={13} />
                    <span>
                      Created{" "}
                      {formatDistanceToNow(new Date(honeyToken.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {format(new Date(honeyToken.createdAt), "MMMM do, yyyy 'at' h:mm a")}
                </TooltipContent>
              </Tooltip>
              {honeyToken.environment && (
                <div className="flex items-center gap-1.5">
                  <MapPinIcon size={13} />
                  <span>
                    {honeyToken.environment.name}
                    {honeyToken.folder?.path && honeyToken.folder.path !== "/"
                      ? ` — ${honeyToken.folder.path}`
                      : ""}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <HexagonIcon size={13} />
                <span>
                  {honeyToken.openEvents} open event{honeyToken.openEvents !== 1 && "s"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <ClockIcon size={13} />
                <span>Active for {formatDistanceToNow(new Date(honeyToken.createdAt))}</span>
              </div>
            </div>

            {!isRevoked && (
              <ProjectPermissionCan
                I={ProjectPermissionSecretActions.DescribeAndReadValue}
                a={ProjectPermissionSub.Secrets}
              >
                {(isAllowed) =>
                  isAllowed && (
                    <div className="mt-4 border-t border-mineshaft-600 pt-4">
                      <div className="mb-2 flex items-center gap-1.5 text-xs text-bunker-300">
                        <KeyIcon size={13} />
                        <span>Credentials</span>
                      </div>
                      {isCredentialsPending && (
                        <div className="flex flex-col gap-2 py-2">
                          <Skeleton className="h-8 w-full rounded-md" />
                          <Skeleton className="h-8 w-full rounded-md" />
                        </div>
                      )}
                      {!isCredentialsPending && credentials && (
                        <div className="flex flex-col gap-x-8 gap-y-2 rounded-sm border border-mineshaft-600 bg-mineshaft-700 p-2">
                          {(
                            HONEY_TOKEN_CREDENTIAL_FIELDS[honeyToken.type as HoneyTokenType] ?? []
                          ).map(({ key, label }) => {
                            const mapping = honeyToken.secretsMapping as Record<string, string>;
                            const secretName = mapping[key];
                            const value = secretName ? credentials[secretName] : undefined;
                            return (
                              <CredentialDisplay key={key} label={label} isSensitive>
                                {value}
                              </CredentialDisplay>
                            );
                          })}
                        </div>
                      )}
                      {!isCredentialsPending && !credentials && (
                        <p className="text-xs text-bunker-400">No credentials available.</p>
                      )}
                    </div>
                  )
                }
              </ProjectPermissionCan>
            )}

            {isRevoked && (
              <div className="mt-4 rounded-md border border-mineshaft-600 bg-mineshaft-800 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <BanIcon size={16} className="text-mineshaft-400" />
                  <p className="text-sm font-medium text-mineshaft-300">Honey token revoked</p>
                </div>
                <p className="text-xs text-bunker-300">
                  The AWS IAM credentials have been revoked and the decoy secrets removed. The honey
                  token record and its events are preserved for audit purposes.
                </p>
              </div>
            )}

            {isTriggered && (
              <div className="mt-4 rounded-md border border-yellow-800/50 bg-yellow-900/20 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <AlertTriangle size={16} className="text-yellow-500" />
                  <p className="text-sm font-medium text-yellow-500">
                    Respond to a triggered honeytoken
                  </p>
                </div>
                <p className="mb-3 text-xs text-bunker-300">
                  Investigate. The events below give you information about when, where, and how the
                  key was used.
                </p>
                <div className="flex gap-6">
                  <div className="flex-1">
                    <p className="text-xs font-medium text-white">1. False alarm confirmed?</p>
                    <p className="text-xs text-bunker-300">
                      You might want to <strong>reset the honeytoken</strong>. This will revert its
                      status to active and hide the past events, so that the honeytoken can be
                      triggered again.
                    </p>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-white">
                      2. Malicious activity confirmed?
                    </p>
                    <p className="text-xs text-bunker-300">
                      1. Take immediate steps as per your company Incident Response Plan.
                      <br />
                      2. <strong>Rotate any real secrets</strong> that were stored alongside the
                      honeytoken, as they may also be compromised.
                      <br />
                      3. <strong>Revoke the honeytoken</strong>. This will prevent any new
                      connections while we keep the compromised key in our records.
                      <br />
                      4. Don&apos;t forget to recreate a new honeytoken to replace it in the same
                      location.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <HoneyTokenEventsSection honeyTokenId={honeyTokenId} projectId={projectId} />
        </div>
      </div>
      <AlertDialog open={isResetOpen} onOpenChange={setIsResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <RotateCcw />
            </AlertDialogMedia>
            <AlertDialogTitle>Reset {honeyToken.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert the honey token status to active and hide past events. The honey
              token will be able to trigger again on new activity.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await handleReset();
                setIsResetOpen(false);
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={isRevokeOpen} onOpenChange={setIsRevokeOpen}>
        <AlertDialogContent className="sm:max-w-xl!">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <BanIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Are you sure you want to revoke {honeyToken.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revoke the AWS IAM credentials and remove the associated decoy secrets from
              this environment. The honey token record and its events will be preserved for audit
              purposes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (revokeInput === honeyToken.name) handleRevoke();
            }}
          >
            <Field>
              <FieldLabel>
                Type <span className="font-bold">{honeyToken.name}</span> to confirm
              </FieldLabel>
              <FieldContent>
                <Input
                  value={revokeInput}
                  onChange={(e) => setRevokeInput(e.target.value)}
                  placeholder={`Type ${honeyToken.name} here`}
                />
              </FieldContent>
            </Field>
          </form>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={handleRevoke}
              disabled={revokeInput !== honeyToken.name}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export const HoneyTokenDetailsByIDPage = () => (
  <ProjectPermissionCan
    I={ProjectPermissionSecretActions.DescribeSecret}
    a={ProjectPermissionSub.Secrets}
    renderGuardBanner
  >
    <PageContent />
  </ProjectPermissionCan>
);
