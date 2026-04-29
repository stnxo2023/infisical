import { Knex } from "knex";

import { TableName } from "../schemas";
import { createOnUpdateTrigger, dropOnUpdateTrigger } from "../utils";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.IdentityAccessTokenRevocation)) {
    return;
  }

  await knex.schema.createTable(TableName.IdentityAccessTokenRevocation, (t) => {
    t.uuid("id").primary();
    t.uuid("identityId").notNullable();
    t.timestamp("expiresAt", { useTz: true }).notNullable();
    // Populated for identity-wide revoke-all markers (id == identityId);
    // null for per-token revocations. Stored so hydration can replay the
    // exact revocation timestamp rather than falling back to createdAt
    // (which reflects BullMQ job execution time, not the revocation call).
    t.timestamp("revokedAt", { useTz: true }).nullable();
    t.timestamps(true, true, true);
    t.index("expiresAt");
  });

  await createOnUpdateTrigger(knex, TableName.IdentityAccessTokenRevocation);
}

export async function down(knex: Knex): Promise<void> {
  await dropOnUpdateTrigger(knex, TableName.IdentityAccessTokenRevocation);
  await knex.schema.dropTableIfExists(TableName.IdentityAccessTokenRevocation);
}
