import { Knex } from "knex";

import { TableName } from "@app/db/schemas";

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TableName.HoneyToken);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TableName.HoneyToken, "connectionId");
  if (!hasColumn) return;

  await knex.schema.alterTable(TableName.HoneyToken, (t) => {
    t.dropForeign(["connectionId"]);
  });

  await knex.schema.alterTable(TableName.HoneyToken, (t) => {
    t.dropColumn("connectionId");
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TableName.HoneyToken);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TableName.HoneyToken, "connectionId");
  if (hasColumn) return;

  await knex.schema.alterTable(TableName.HoneyToken, (t) => {
    t.uuid("connectionId").notNullable();
    t.foreign("connectionId").references("id").inTable(TableName.AppConnection);
  });
}
