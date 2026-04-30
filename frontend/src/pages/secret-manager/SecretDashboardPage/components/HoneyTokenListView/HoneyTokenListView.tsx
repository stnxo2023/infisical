import { useState } from "react";

import {
  EditHoneyTokenModal,
  HoneyTokenDetailsDrawer,
  RevokeHoneyTokenModal,
  ViewHoneyTokenCredentialsModal
} from "@app/components/honey-tokens";
import { useProject } from "@app/context";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { HoneyTokenItem } from "./HoneyTokenItem";

type Props = {
  honeyTokens?: TDashboardHoneyToken[];
};

export const HoneyTokenListView = ({ honeyTokens }: Props) => {
  const { projectId } = useProject();

  const [revokeTarget, setRevokeTarget] = useState<TDashboardHoneyToken>();
  const [editTarget, setEditTarget] = useState<TDashboardHoneyToken>();
  const [credentialsTarget, setCredentialsTarget] = useState<TDashboardHoneyToken>();
  const [detailsTarget, setDetailsTarget] = useState<TDashboardHoneyToken>();

  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => setEditTarget(honeyToken)}
          onRevoke={() => setRevokeTarget(honeyToken)}
          onViewCredentials={() => setCredentialsTarget(honeyToken)}
          onViewDetails={() => setDetailsTarget(honeyToken)}
        />
      ))}
      <EditHoneyTokenModal
        isOpen={Boolean(editTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEditTarget(undefined);
        }}
        honeyToken={editTarget}
      />
      <RevokeHoneyTokenModal
        isOpen={Boolean(revokeTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRevokeTarget(undefined);
        }}
        honeyToken={revokeTarget}
      />
      <ViewHoneyTokenCredentialsModal
        isOpen={Boolean(credentialsTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setCredentialsTarget(undefined);
        }}
        honeyToken={credentialsTarget}
        projectId={projectId}
      />
      <HoneyTokenDetailsDrawer
        isOpen={Boolean(detailsTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDetailsTarget(undefined);
        }}
        honeyTokenId={detailsTarget?.id ?? ""}
        projectId={projectId}
      />
    </>
  );
};
