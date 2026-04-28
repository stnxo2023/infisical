import { TDbClient } from "@app/db";
import { TableName } from "@app/db/schemas";
import { ormify } from "@app/lib/knex";

export type THoneyTokenEventDALFactory = ReturnType<typeof honeyTokenEventDALFactory>;

export const honeyTokenEventDALFactory = (db: TDbClient) => {
  const orm = ormify(db, TableName.HoneyTokenEvent);
  return orm;
};
