import { useState } from "react";

import {
  EditHoneyTokenModal,
  RevokeHoneyTokenModal,
  ViewHoneyTokenCredentialsModal
} from "@app/components/honey-tokens";
import { useWorkspace } from "@app/context";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { HoneyTokenItem } from "./HoneyTokenItem";

type Props = {
  honeyTokens?: TDashboardHoneyToken[];
};

export const HoneyTokenListView = ({ honeyTokens }: Props) => {
  const { currentWorkspace } = useWorkspace();
  const projectId = currentWorkspace?.id || "";

  const [revokeTarget, setRevokeTarget] = useState<TDashboardHoneyToken>();
  const [editTarget, setEditTarget] = useState<TDashboardHoneyToken>();
  const [credentialsTarget, setCredentialsTarget] = useState<TDashboardHoneyToken>();

  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => setEditTarget(honeyToken)}
          onRevoke={() => setRevokeTarget(honeyToken)}
          onViewCredentials={() => setCredentialsTarget(honeyToken)}
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
    </>
  );
};
