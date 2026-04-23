import { z } from "zod";

import { TOvhConnection } from "@app/services/app-connection/ovh";

import { CreateOvhSyncSchema, OvhSyncListItemSchema, OvhSyncSchema } from "./ovh-sync-schemas";

export type TOvhSync = z.infer<typeof OvhSyncSchema>;

export type TOvhSyncInput = z.infer<typeof CreateOvhSyncSchema>;

export type TOvhSyncListItem = z.infer<typeof OvhSyncListItemSchema>;

export type TOvhSyncWithCredentials = TOvhSync & {
  connection: TOvhConnection;
};
