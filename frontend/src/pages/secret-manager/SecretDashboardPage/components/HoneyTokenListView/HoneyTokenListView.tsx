import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { HoneyTokenItem } from "./HoneyTokenItem";

type Props = {
  honeyTokens?: TDashboardHoneyToken[];
};

export const HoneyTokenListView = ({ honeyTokens }: Props) => {
  return (
    <>
      {honeyTokens?.map((honeyToken) => (
        <HoneyTokenItem
          key={honeyToken.id}
          honeyToken={honeyToken}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      ))}
    </>
  );
};
