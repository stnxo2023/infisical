import { TDbClient } from "@app/db";
import { TableName, TIdentityAccessTokenRevocations } from "@app/db/schemas";
import { DatabaseError } from "@app/lib/errors";

type TRevocationRow = Pick<TIdentityAccessTokenRevocations, "id" | "identityId" | "revokedAt" | "createdAt">;

export type TIdentityAccessTokenRevocationDALFactory = ReturnType<typeof identityAccessTokenRevocationDALFactory>;

// `id` is set explicitly: JWT jti for per-token revocations, identityId for
// revoke-all sentinels. `revokedAt` is populated only for sentinels so
// hydration can replay the exact revocation time rather than falling back to
// createdAt (which is BullMQ job execution time, not the revocation call).
type TInsertRevocationInput = {
  id: string;
  identityId: string;
  expiresAt: Date;
  revokedAt?: Date | null;
};

export const identityAccessTokenRevocationDALFactory = (db: TDbClient) => {
  const insertRevocation = async (row: TInsertRevocationInput) => {
    try {
      await db(TableName.IdentityAccessTokenRevocation)
        .insert(row)
        .onConflict(["id"])
        .merge({ updatedAt: db.fn.now() });
    } catch (error) {
      throw new DatabaseError({ error, name: "IdentityAccessTokenRevocationInsert" });
    }
  };

  // Cursor pagination keyed on id. The WHERE on expiresAt prunes expired rows
  // from the scan; ORDER BY id keeps batches stable across MVCC churn between
  // calls.
  const findActive = async ({ limit, afterId }: { limit: number; afterId?: string }): Promise<TRevocationRow[]> => {
    try {
      let query = db
        .replicaNode()(TableName.IdentityAccessTokenRevocation)
        .select("id", "identityId", "revokedAt", "createdAt")
        .where("expiresAt", ">", db.fn.now())
        .orderBy("id", "asc")
        .limit(limit);

      if (afterId) {
        query = query.andWhere("id", ">", afterId);
      }

      return (await query) as TRevocationRow[];
    } catch (error) {
      throw new DatabaseError({ error, name: "IdentityAccessTokenRevocationFindActive" });
    }
  };

  const removeExpiredRevocations = async () => {
    try {
      await db(TableName.IdentityAccessTokenRevocation).where("expiresAt", "<", db.fn.now()).delete();
    } catch (error) {
      throw new DatabaseError({ error, name: "IdentityAccessTokenRevocationRemoveExpired" });
    }
  };

  return {
    insertRevocation,
    findActive,
    removeExpiredRevocations
  };
};
