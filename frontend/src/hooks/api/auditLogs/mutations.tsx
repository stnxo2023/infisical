import { useMutation } from "@tanstack/react-query";

import { apiRequest } from "@app/config/request";

type TrackAuditLogViewInput = { auditLogId: string };

export const useTrackAuditLogView = () =>
  useMutation({
    mutationFn: async ({ auditLogId }: TrackAuditLogViewInput) => {
      const { data } = await apiRequest.post<{ tracked: boolean }>(
        `/api/v1/organization/audit-logs/${auditLogId}/track-log-details-view`
      );
      return data;
    }
  });
