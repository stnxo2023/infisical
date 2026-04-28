import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiRequest } from "@app/config/request";
import { dashboardKeys } from "@app/hooks/api/dashboard/queries";

import { TCreateHoneyTokenDTO, THoneyToken } from "./types";

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
