import { Knex } from "knex";

import { TableName } from "@app/db/schemas";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TableName.HoneyTokenSecretMapping))) {
    await knex.schema.createTable(TableName.HoneyTokenSecretMapping, (t) => {
      t.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());
      t.uuid("secretId").notNullable().unique();
      t.foreign("secretId").references("id").inTable(TableName.SecretV2).onDelete("CASCADE");
      t.uuid("honeyTokenId").notNullable();
      t.foreign("honeyTokenId").references("id").inTable(TableName.HoneyToken).onDelete("CASCADE");
      t.unique(["honeyTokenId", "secretId"]);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.HoneyTokenSecretMapping)) {
    await knex.schema.dropTableIfExists(TableName.HoneyTokenSecretMapping);
  }
}
