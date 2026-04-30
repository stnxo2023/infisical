import { Knex } from "knex";

import { TableName } from "../schemas";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn(TableName.IdentityKubernetesAuth, "enableSsl"))) {
    await knex.schema.alterTable(TableName.IdentityKubernetesAuth, (t) => {
      t.boolean("enableSsl").defaultTo(false).notNullable();
    });

    await knex(TableName.IdentityKubernetesAuth)
      .whereNotNull("encryptedKubernetesCaCertificate")
      .update({ enableSsl: true });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn(TableName.IdentityKubernetesAuth, "enableSsl")) {
    await knex.schema.alterTable(TableName.IdentityKubernetesAuth, (t) => {
      t.dropColumn("enableSsl");
    });
  }
}
