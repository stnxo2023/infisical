import { Knex } from "knex";

import { TableName } from "@app/db/schemas";
import { createOnUpdateTrigger, dropOnUpdateTrigger } from "@app/db/utils";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TableName.HoneyTokenConfig))) {
    await knex.schema.createTable(TableName.HoneyTokenConfig, (t) => {
      t.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());
      t.uuid("orgId").notNullable();
      t.foreign("orgId").references("id").inTable(TableName.Organization).onDelete("CASCADE");
      t.string("type").notNullable();
      t.uuid("connectionId").notNullable();
      t.foreign("connectionId").references("id").inTable(TableName.AppConnection);
      t.binary("encryptedConfig");
      t.timestamps(true, true, true);
    });

    await createOnUpdateTrigger(knex, TableName.HoneyTokenConfig);
    await knex.schema.alterTable(TableName.HoneyTokenConfig, (t) => {
      t.unique(["orgId", "type"]);
    });
  }

  if (!(await knex.schema.hasTable(TableName.HoneyToken))) {
    await knex.schema.createTable(TableName.HoneyToken, (t) => {
      t.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());
      t.string("name", 64).notNullable();
      t.string("type").notNullable();
      t.string("status").notNullable().defaultTo("active");
      t.string("projectId").notNullable();
      t.foreign("projectId").references("id").inTable(TableName.Project).onDelete("CASCADE");
      t.uuid("connectionId").notNullable();
      t.foreign("connectionId").references("id").inTable(TableName.AppConnection);
      t.binary("encryptedCredentials").notNullable();
      t.jsonb("secretsMapping").notNullable();
      t.timestamps(true, true, true);
    });

    await createOnUpdateTrigger(knex, TableName.HoneyToken);
  }

  if (!(await knex.schema.hasTable(TableName.HoneyTokenEvent))) {
    await knex.schema.createTable(TableName.HoneyTokenEvent, (t) => {
      t.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());
      t.uuid("honeyTokenId").notNullable();
      t.foreign("honeyTokenId").references("id").inTable(TableName.HoneyToken).onDelete("CASCADE");
      t.string("eventType").notNullable();
      t.jsonb("metadata");
      t.timestamps(true, true, true);
    });

    await createOnUpdateTrigger(knex, TableName.HoneyTokenEvent);
    await knex.schema.alterTable(TableName.HoneyTokenEvent, (t) => {
      t.index(["honeyTokenId", "createdAt"]);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TableName.HoneyTokenEvent);
  await dropOnUpdateTrigger(knex, TableName.HoneyTokenEvent);
  await knex.schema.dropTableIfExists(TableName.HoneyToken);
  await dropOnUpdateTrigger(knex, TableName.HoneyToken);
  await knex.schema.dropTableIfExists(TableName.HoneyTokenConfig);
  await dropOnUpdateTrigger(knex, TableName.HoneyTokenConfig);
}
