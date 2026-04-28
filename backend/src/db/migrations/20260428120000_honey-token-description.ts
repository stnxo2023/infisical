import { Knex } from "knex";

import { TableName } from "@app/db/schemas";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.HoneyToken)) {
    const hasDescription = await knex.schema.hasColumn(TableName.HoneyToken, "description");
    if (!hasDescription) {
      await knex.schema.alterTable(TableName.HoneyToken, (t) => {
        t.string("description", 256).nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.HoneyToken)) {
    const hasDescription = await knex.schema.hasColumn(TableName.HoneyToken, "description");
    if (hasDescription) {
      await knex.schema.alterTable(TableName.HoneyToken, (t) => {
        t.dropColumn("description");
      });
    }
  }
}
