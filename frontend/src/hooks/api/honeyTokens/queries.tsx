import { useQuery } from "@tanstack/react-query";

import { apiRequest } from "@app/config/request";

export const honeyTokenKeys = {
  all: ["honeyTokens"] as const,
  list: (projectId: string) => [...honeyTokenKeys.all, "list", projectId] as const,
  credentials: (honeyTokenId: string) =>
    [...honeyTokenKeys.all, "credentials", honeyTokenId] as const
};

export const useGetHoneyTokenCredentials = ({
  honeyTokenId,
  projectId,
  enabled = true
}: {
  honeyTokenId: string;
  projectId: string;
  enabled?: boolean;
}) =>
  useQuery({
    queryKey: honeyTokenKeys.credentials(honeyTokenId),
    queryFn: async () => {
      const { data } = await apiRequest.get<{ credentials: Record<string, string> }>(
        `/api/v1/honey-tokens/${honeyTokenId}/credentials`,
        { params: { projectId } }
      );
      return data.credentials;
    },
    enabled
  });
