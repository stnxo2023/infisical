import { useState } from "react";

import { DeleteHoneyTokenModal, EditHoneyTokenModal } from "@app/components/honey-tokens";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { HoneyTokenItem } from "./HoneyTokenItem";

type Props = {
  honeyTokens?: TDashboardHoneyToken[];
};

export const HoneyTokenListView = ({ honeyTokens }: Props) => {
  const [deleteTarget, setDeleteTarget] = useState<TDashboardHoneyToken>();
  const [editTarget, setEditTarget] = useState<TDashboardHoneyToken>();

  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => setEditTarget(honeyToken)}
          onDelete={() => setDeleteTarget(honeyToken)}
        />
      ))}
      <EditHoneyTokenModal
        isOpen={Boolean(editTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEditTarget(undefined);
        }}
        honeyToken={editTarget}
      />
      <DeleteHoneyTokenModal
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleteTarget(undefined);
        }}
        honeyToken={deleteTarget}
      />
    </>
  );
};
