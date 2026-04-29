import { Knex } from "knex";

import { TDbClient } from "@app/db";
import { TableName } from "@app/db/schemas";
import { ormify } from "@app/lib/knex";

export type TPamSessionEventChunkDALFactory = ReturnType<typeof pamSessionEventChunkDALFactory>;

export const pamSessionEventChunkDALFactory = (db: TDbClient) => {
  const orm = ormify(db, TableName.PamSessionEventChunk);

  const findAllBySessionId = async (sessionId: string, tx?: Knex) => {
    return (tx || db.replicaNode())(TableName.PamSessionEventChunk)
      .where("sessionId", sessionId)
      .orderBy("chunkIndex", "asc")
      .select("*");
  };

  const findByChunkIndex = async (sessionId: string, chunkIndex: number, tx?: Knex) => {
    return (tx || db.replicaNode())(TableName.PamSessionEventChunk).where({ sessionId, chunkIndex }).first();
  };

  return { ...orm, findAllBySessionId, findByChunkIndex };
};
