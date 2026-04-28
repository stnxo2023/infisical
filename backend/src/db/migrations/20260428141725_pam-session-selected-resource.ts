import { Knex } from "knex";

import { TableName } from "../schemas";

// Domain accounts (e.g. Active Directory) are not parented to a specific resource — a
// single domain account can target any of the domain-linked resources. The existing
// `resourceId` column on pam_sessions is derived from `account.resourceId` and is null
// for these sessions. `selectedResourceId` records the specific resource the user
// picked at session-start time so reads can resolve a target via
// `selectedResourceId ?? resourceId`.
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.PamSession)) {
    const hasCol = await knex.schema.hasColumn(TableName.PamSession, "selectedResourceId");
    if (!hasCol) {
      await knex.schema.alterTable(TableName.PamSession, (t) => {
        t.uuid("selectedResourceId").nullable().references("id").inTable(TableName.PamResource).onDelete("SET NULL");
        t.index("selectedResourceId");
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.PamSession)) {
    const hasCol = await knex.schema.hasColumn(TableName.PamSession, "selectedResourceId");
    if (hasCol) {
      await knex.schema.alterTable(TableName.PamSession, (t) => {
        t.dropIndex("selectedResourceId");
        t.dropColumn("selectedResourceId");
      });
    }
  }
}
