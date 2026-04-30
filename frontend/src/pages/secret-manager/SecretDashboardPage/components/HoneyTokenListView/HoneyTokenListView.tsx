import { useRef, useState } from "react";

import {
  EditHoneyTokenModal,
  HoneyTokenDetailsDrawer,
  type HoneyTokenDetailsDrawerHandle,
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
  const honeyTokenDetailsRef = useRef<HoneyTokenDetailsDrawerHandle>(null);

  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => setEditTarget(honeyToken)}
          onRevoke={() => setRevokeTarget(honeyToken)}
          onViewCredentials={() => setCredentialsTarget(honeyToken)}
          onViewDetails={() => honeyTokenDetailsRef.current?.open(honeyToken.id)}
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
      <HoneyTokenDetailsDrawer ref={honeyTokenDetailsRef} projectId={projectId} />
    </>
  );
};
