import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiRequest } from "@app/config/request";

import { honeyTokenKeys } from "./queries";
import { TUpsertHoneyTokenConfigDTO } from "./types";

export const useUpsertHoneyTokenConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (dto: TUpsertHoneyTokenConfigDTO) => {
      const { data } = await apiRequest.put("/api/v1/honey-tokens/configs", dto);
      return data.config;
    },
    onSuccess: (_, dto) => {
      queryClient.invalidateQueries({ queryKey: honeyTokenKeys.config(dto.type) });
    }
  });
};
