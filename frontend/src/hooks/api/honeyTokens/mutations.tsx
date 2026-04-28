import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiRequest } from "@app/config/request";
import { dashboardKeys } from "@app/hooks/api/dashboard/queries";

import {
  TCreateHoneyTokenDTO,
  TDeleteHoneyTokenDTO,
  THoneyToken,
  TUpdateHoneyTokenDTO
} from "./types";

export const useCreateHoneyToken = () => {
  const queryClient = useQueryClient();

  return useMutation<THoneyToken, object, TCreateHoneyTokenDTO>({
    mutationFn: async (dto) => {
      const { data } = await apiRequest.post<THoneyToken>("/api/v1/honey-tokens", dto);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["honeyTokens"] });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all() });
    }
  });
};

export const useUpdateHoneyToken = () => {
  const queryClient = useQueryClient();

  return useMutation<THoneyToken, object, TUpdateHoneyTokenDTO>({
    mutationFn: async ({ honeyTokenId, ...dto }) => {
      const { data } = await apiRequest.patch<{ honeyToken: THoneyToken }>(
        `/api/v1/honey-tokens/${honeyTokenId}`,
        dto
      );
      return data.honeyToken;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["honeyTokens"] });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all() });
    }
  });
};

export const useDeleteHoneyToken = () => {
  const queryClient = useQueryClient();

  return useMutation<{ honeyTokenId: string }, object, TDeleteHoneyTokenDTO>({
    mutationFn: async ({ honeyTokenId, projectId }) => {
      const { data } = await apiRequest.delete<{ honeyTokenId: string }>(
        `/api/v1/honey-tokens/${honeyTokenId}`,
        { data: { projectId } }
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["honeyTokens"] });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all() });
    }
  });
};
