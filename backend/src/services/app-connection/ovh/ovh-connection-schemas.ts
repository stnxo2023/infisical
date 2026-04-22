import z from "zod";

import { AppConnections } from "@app/lib/api-docs";
import { AppConnection } from "@app/services/app-connection/app-connection-enums";
import {
  BaseAppConnectionSchema,
  GenericCreateAppConnectionFieldsSchema,
  GenericUpdateAppConnectionFieldsSchema
} from "@app/services/app-connection/app-connection-schemas";

import { APP_CONNECTION_NAME_MAP } from "../app-connection-maps";
import { OVHConnectionMethod } from "./ovh-connection-enums";

export const OvhConnectionPkcs12CredentialsSchema = z.object({
  pkcs12Certificate: z
    .string()
    .trim()
    .min(1, "PKCS#12 certificate required")
    .describe(AppConnections.CREDENTIALS.OVH.pkcs12Certificate),
  pkcs12Passphrase: z.string().optional().describe(AppConnections.CREDENTIALS.OVH.pkcs12Passphrase),
  okmsDomain: z.string().trim().min(1, "OKMS domain required").describe(AppConnections.CREDENTIALS.OVH.okmsDomain),
  okmsId: z.string().trim().min(1, "OKMS ID required").describe(AppConnections.CREDENTIALS.OVH.okmsId)
});

const BaseOvhConnectionSchema = BaseAppConnectionSchema.extend({ app: z.literal(AppConnection.OVH) });

export const OvhConnectionSchema = BaseOvhConnectionSchema.extend({
  method: z.literal(OVHConnectionMethod.Pkcs12Certificate),
  credentials: OvhConnectionPkcs12CredentialsSchema
});

export const SanitizedOvhConnectionSchema = z.discriminatedUnion("method", [
  BaseOvhConnectionSchema.extend({
    method: z.literal(OVHConnectionMethod.Pkcs12Certificate),
    credentials: OvhConnectionPkcs12CredentialsSchema.pick({
      okmsDomain: true,
      okmsId: true
    })
  }).describe(JSON.stringify({ title: `${APP_CONNECTION_NAME_MAP[AppConnection.OVH]} (PKCS#12 Certificate)` }))
]);

export const ValidateOvhConnectionCredentialsSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal(OVHConnectionMethod.Pkcs12Certificate).describe(AppConnections.CREATE(AppConnection.OVH).method),
    credentials: OvhConnectionPkcs12CredentialsSchema.describe(AppConnections.CREATE(AppConnection.OVH).credentials)
  })
]);

export const CreateOvhConnectionSchema = ValidateOvhConnectionCredentialsSchema.and(
  GenericCreateAppConnectionFieldsSchema(AppConnection.OVH)
);

export const UpdateOvhConnectionSchema = z
  .object({
    credentials: OvhConnectionPkcs12CredentialsSchema.optional().describe(
      AppConnections.UPDATE(AppConnection.OVH).credentials
    )
  })
  .and(GenericUpdateAppConnectionFieldsSchema(AppConnection.OVH));

export const OvhConnectionListItemSchema = z
  .object({
    name: z.literal("OVH"),
    app: z.literal(AppConnection.OVH),
    methods: z.nativeEnum(OVHConnectionMethod).array()
  })
  .describe(JSON.stringify({ title: APP_CONNECTION_NAME_MAP[AppConnection.OVH] }));
