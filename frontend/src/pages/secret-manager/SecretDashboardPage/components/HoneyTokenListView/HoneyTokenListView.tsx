import { useState } from "react";

import { DeleteHoneyTokenModal } from "@app/components/honey-tokens";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { HoneyTokenItem } from "./HoneyTokenItem";

type Props = {
  honeyTokens?: TDashboardHoneyToken[];
};

export const HoneyTokenListView = ({ honeyTokens }: Props) => {
  const [deleteTarget, setDeleteTarget] = useState<TDashboardHoneyToken>();

  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => {}}
          onDelete={() => setDeleteTarget(honeyToken)}
        />
      ))}
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
