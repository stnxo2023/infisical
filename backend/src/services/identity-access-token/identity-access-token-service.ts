import { Knex } from "knex";

import { IdentityAuthMethod, OrgMembershipStatus, TIdentityAccessTokens } from "@app/db/schemas";
import { IdentityTokenStateFields, KeyStorePrefixes, TKeyStoreFactory } from "@app/keystore/keystore";
import { getConfig } from "@app/lib/config/env";
import { crypto } from "@app/lib/crypto";
import { UnauthorizedError } from "@app/lib/errors";
import { checkIPAgainstBlocklist, TIp } from "@app/lib/ip";
import { logger } from "@app/lib/logger";

import { ActorType } from "../auth/auth-type";
import { TIdentityDALFactory } from "../identity/identity-dal";
import { TOrgDALFactory } from "../org/org-dal";
import { TIdentityAccessTokenDALFactory } from "./identity-access-token-dal";
import {
  assertFastPathClaims,
  assertMinimalRenewClaims,
  assertRevocableClaims,
  computeIssuedTtl,
  hasFullRenewClaims,
  hasNonWildcardTrustedIps,
  parseRevokedAfter,
  parseUsesRemaining,
  resolveTtlInputs,
  signIdentityAccessToken,
  verifyAccessTokenJwt
} from "./identity-access-token-fns";
import { TIdentityAccessTokenQueueServiceFactory } from "./identity-access-token-queue";
import { TIdentityAccessTokenRevocationDALFactory } from "./identity-access-token-revocation-dal";
import {
  TAWSAuthDetails,
  TIdentityAccessTokenJwtPayload,
  TKubernetesAuthDetails,
  TOidcAuthDetails,
  TRenewAccessTokenDTO,
  TRenewSource
} from "./identity-access-token-types";

export type TIssueIdentityAccessTokenInput = {
  identityId: string;
  identityName: string;
  authMethod: IdentityAuthMethod;
  orgId: string;
  rootOrgId: string;
  parentOrgId: string;
  subOrganizationId: string | null;
  accessTokenTTL: number;
  accessTokenMaxTTL: number;
  accessTokenNumUsesLimit: number;
  // 0 = standard TTL/MaxTTL. > 0 = periodic mode (TTL is the period).
  accessTokenPeriod: number;
  accessTokenTrustedIps: TIp[];
  clientSecretId?: string;
  identityAuth?: {
    oidc?: TOidcAuthDetails;
    kubernetes?: TKubernetesAuthDetails;
    aws?: TAWSAuthDetails;
  };
  // Set by Token Auth to insert a real PG row in its transaction; every other
  // auth method omits this and gets a fresh in-memory UUID.
  persistToPg?: { tx: Knex; name?: string | null };
};

export type TIssueIdentityAccessTokenOutput = {
  accessToken: string;
  identityAccessToken: TIdentityAccessTokens;
};

type TIdentityAccessTokenServiceFactoryDep = {
  identityAccessTokenDAL: TIdentityAccessTokenDALFactory;
  identityAccessTokenRevocationDAL: TIdentityAccessTokenRevocationDALFactory;
  identityDAL: Pick<TIdentityDALFactory, "getTrustedIpsByAuthMethod" | "findById">;
  orgDAL: Pick<TOrgDALFactory, "findEffectiveOrgMembership">;
  keyStore: Pick<
    TKeyStoreFactory,
    "hashGetMulti" | "hashIncrementBy" | "hashSetWithExpiry" | "setItemWithExpiry" | "setItemWithExpiryNX"
  >;
  identityAccessTokenQueue: TIdentityAccessTokenQueueServiceFactory;
};

export type TIdentityAccessTokenServiceFactory = ReturnType<typeof identityAccessTokenServiceFactory>;

export const identityAccessTokenServiceFactory = ({
  identityAccessTokenDAL,
  identityAccessTokenRevocationDAL,
  identityDAL,
  orgDAL,
  keyStore,
  identityAccessTokenQueue
}: TIdentityAccessTokenServiceFactoryDep) => {
  // Token Auth materializes a PG row at issuance (admin-managed UI list);
  // every other method lazily inserts a row only on revoke.
  const issueIdentityAccessToken = async (
    input: TIssueIdentityAccessTokenInput
  ): Promise<TIssueIdentityAccessTokenOutput> => {
    const appCfg = getConfig();
    const issuedAt = new Date();

    const period = Number(input.accessTokenPeriod) || 0;
    const { requestedTTL, requestedMaxTTL } = resolveTtlInputs(
      period,
      Number(input.accessTokenTTL) || 0,
      Number(input.accessTokenMaxTTL) || 0
    );

    const creationEpoch = Math.floor(issuedAt.getTime() / 1000);
    const ttl = computeIssuedTtl({
      requestedTTL,
      maxTTL: requestedMaxTTL,
      creationEpoch,
      nowSeconds: creationEpoch
    });

    const ipRestrictionEnabled = hasNonWildcardTrustedIps(input.accessTokenTrustedIps);
    const numUsesLimit = Number(input.accessTokenNumUsesLimit) || 0;

    const baseRow = {
      identityId: input.identityId,
      isAccessTokenRevoked: false,
      accessTokenTTL: ttl,
      accessTokenMaxTTL: requestedMaxTTL,
      accessTokenNumUses: 0,
      accessTokenNumUsesLimit: numUsesLimit,
      accessTokenPeriod: period,
      authMethod: input.authMethod,
      subOrganizationId: input.subOrganizationId
    };

    let identityAccessToken: TIdentityAccessTokens;
    if (input.persistToPg) {
      identityAccessToken = await identityAccessTokenDAL.create(
        { ...baseRow, name: input.persistToPg.name ?? null },
        input.persistToPg.tx
      );
    } else {
      identityAccessToken = {
        ...baseRow,
        id: crypto.nativeCrypto.randomUUID(),
        createdAt: issuedAt,
        updatedAt: issuedAt
      };
    }

    const { accessToken } = signIdentityAccessToken({
      identityAccessTokenId: identityAccessToken.id,
      identityId: input.identityId,
      identityName: input.identityName,
      authMethod: input.authMethod,
      orgId: input.orgId,
      rootOrgId: input.rootOrgId,
      parentOrgId: input.parentOrgId,
      clientSecretId: input.clientSecretId ?? "",
      numUsesLimit,
      ipRestrictionEnabled,
      ttlSeconds: ttl,
      // Store the original configured value (not the ceiling-capped computed TTL)
      // so that renewals re-apply configMaxTTL fresh each time.
      accessTokenTTL: requestedTTL,
      accessTokenMaxTTL: requestedMaxTTL,
      accessTokenPeriod: period,
      creationEpoch,
      identityAuth: input.identityAuth
    });

    if (numUsesLimit > 0) {
      await keyStore.hashSetWithExpiry(
        KeyStorePrefixes.IdentityTokenState(input.identityId),
        { [IdentityTokenStateFields.UsesRemaining(identityAccessToken.id)]: numUsesLimit },
        appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
      );
    }

    return { accessToken, identityAccessToken };
  };

  const fnValidateIdentityAccessTokenFast = async (rawToken: TIdentityAccessTokenJwtPayload, ipAddress?: string) => {
    const appCfg = getConfig();
    const token = assertFastPathClaims(rawToken);

    // Legacy tokens (pre-redesign) were signed without `expiresIn` so the JWT
    // has no `exp`. For those, enforce the `iat + MAX_AGE` ceiling here.
    // New tokens always have `exp`; jwt.verify already rejected expired ones.
    const issuedAtMs = token.iat * 1000;
    if (typeof token.exp !== "number" && Date.now() > issuedAtMs + appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE * 1000) {
      throw new UnauthorizedError({ message: "Identity access token exceeded max age, please re-authenticate" });
    }

    const stateKey = KeyStorePrefixes.IdentityTokenState(token.identityId);

    const [revokedAfter, usesRemainingRaw] = await keyStore.hashGetMulti(stateKey, [
      IdentityTokenStateFields.RevokedAfter,
      IdentityTokenStateFields.UsesRemaining(token.jti)
    ]);

    const revokedAfterMs = parseRevokedAfter(revokedAfter);
    if (revokedAfterMs !== null && issuedAtMs < revokedAfterMs) {
      throw new UnauthorizedError({ message: "Failed to authorize: identity tokens have been revoked" });
    }

    // The counter doubles as the per-token revoke marker. null means
    // unlimited and not revoked; <= 0 means revoked or exhausted.
    const remainingFromState = parseUsesRemaining(usesRemainingRaw);
    if (remainingFromState !== null && remainingFromState <= 0) {
      throw new UnauthorizedError({ message: "Failed to authorize: token revoked or usage limit reached" });
    }

    if (token.numUsesLimit && token.numUsesLimit > 0) {
      if (remainingFromState === null) {
        // Counter was lost (Redis flush). Re-seed from the JWT's numUsesLimit claim
        // and allow this request; subsequent requests decrement the live counter.
        await keyStore.hashSetWithExpiry(
          stateKey,
          { [IdentityTokenStateFields.UsesRemaining(token.jti)]: token.numUsesLimit - 1 },
          appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
        );
      } else {
        const remaining = await keyStore.hashIncrementBy(
          stateKey,
          IdentityTokenStateFields.UsesRemaining(token.jti),
          -1
        );
        if (remaining < 0) {
          throw new UnauthorizedError({ message: "Failed to authorize: token usage limit reached" });
        }
      }
    }

    if (ipAddress && token.authMethod) {
      const trustedIps = await identityDAL.getTrustedIpsByAuthMethod(
        token.identityId,
        token.authMethod as IdentityAuthMethod
      );
      if (hasNonWildcardTrustedIps(trustedIps as TIp[] | null | undefined)) {
        checkIPAgainstBlocklist({
          ipAddress,
          trustedIps: trustedIps as TIp[]
        });
      }
    }

    const orgMembership = await orgDAL.findEffectiveOrgMembership({
      actorType: ActorType.IDENTITY,
      actorId: token.identityId,
      orgId: token.orgId,
      status: OrgMembershipStatus.Accepted
    });
    if (!orgMembership) {
      throw new UnauthorizedError({ message: "Identity is not a member of the organization" });
    }
    if (!orgMembership.isActive) {
      throw new UnauthorizedError({ message: "Identity organization membership is inactive" });
    }

    return {
      identityId: token.identityId,
      identityName: token.identityName ?? "",
      name: token.identityName ?? "",
      orgId: token.orgId,
      rootOrgId: token.rootOrgId,
      parentOrgId: token.parentOrgId,
      orgName: undefined as string | undefined,
      authMethod: (token.authMethod ?? "") as string
    };
  };

  // Loads the renewal source for a legacy JWT from PG. Legacy tokens predate
  // the lazy-insert model and always have a row; revoked or missing rows mean
  // the token can't be safely upgraded.
  const loadLegacyRenewSource = async (
    decoded: TIdentityAccessTokenJwtPayload & { identityAccessTokenId: string }
  ): Promise<TRenewSource> => {
    const row = await identityAccessTokenDAL.findOne({ id: decoded.identityAccessTokenId });
    if (!row || row.isAccessTokenRevoked) {
      throw new UnauthorizedError({ message: "Cannot renew revoked or unknown access token" });
    }
    const fallbackOrgId = decoded.orgId ?? row.identityOrgId ?? "";
    return {
      authMethod: row.authMethod as IdentityAuthMethod,
      accessTokenTTL: row.accessTokenTTL,
      accessTokenMaxTTL: row.accessTokenMaxTTL,
      accessTokenPeriod: row.accessTokenPeriod,
      // Anchor the upgraded JWT's maxTTL budget on the row's createdAt so the
      // legacy lifetime carries over without a free renewal-time extension.
      creationEpoch: Math.floor(row.createdAt.getTime() / 1000),
      identityName: row.identityName ?? decoded.identityName ?? "",
      orgId: fallbackOrgId,
      rootOrgId: decoded.rootOrgId ?? fallbackOrgId,
      parentOrgId: decoded.parentOrgId ?? fallbackOrgId,
      clientSecretId: decoded.clientSecretId ?? "",
      identityAuth: decoded.identityAuth
    };
  };

  const renewAccessToken = async ({ accessToken }: TRenewAccessTokenDTO) => {
    const appCfg = getConfig();
    const decodedToken = assertMinimalRenewClaims(verifyAccessTokenJwt(accessToken));

    // Single-JWT max age. New-format validation enforces this on the hot path
    // via the same check; mirror it here so legacy JWTs (which were signed
    // with arbitrarily long expiresIn) can't renew themselves indefinitely.
    if (decodedToken.iat * 1000 + appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE * 1000 < Date.now()) {
      throw new UnauthorizedError({ message: "Identity access token exceeded max age, please re-authenticate" });
    }

    const source: TRenewSource = hasFullRenewClaims(decodedToken)
      ? {
          authMethod: decodedToken.authMethod,
          accessTokenTTL: decodedToken.accessTokenTTL,
          accessTokenMaxTTL: decodedToken.accessTokenMaxTTL,
          accessTokenPeriod: decodedToken.accessTokenPeriod,
          creationEpoch: decodedToken.creationEpoch,
          identityName: decodedToken.identityName ?? "",
          orgId: decodedToken.orgId ?? "",
          rootOrgId: decodedToken.rootOrgId ?? decodedToken.orgId ?? "",
          parentOrgId: decodedToken.parentOrgId ?? decodedToken.orgId ?? "",
          clientSecretId: decodedToken.clientSecretId,
          identityAuth: decodedToken.identityAuth
        }
      : await loadLegacyRenewSource(decodedToken);

    const stateKey = KeyStorePrefixes.IdentityTokenState(decodedToken.identityId);
    const { jti } = decodedToken;

    const [existingUsesRemainingRaw, revokedAfterRaw] = await keyStore.hashGetMulti(stateKey, [
      IdentityTokenStateFields.UsesRemaining(jti),
      IdentityTokenStateFields.RevokedAfter
    ]);

    const existingRemaining = parseUsesRemaining(existingUsesRemainingRaw);
    if (existingRemaining !== null && existingRemaining <= 0) {
      throw new UnauthorizedError({ message: "Cannot renew revoked or exhausted access token" });
    }

    const renewRevokedAfterMs = parseRevokedAfter(revokedAfterRaw);
    if (renewRevokedAfterMs !== null && decodedToken.iat * 1000 < renewRevokedAfterMs) {
      throw new UnauthorizedError({ message: "Cannot renew: identity tokens have been revoked" });
    }

    const { requestedTTL, requestedMaxTTL } = resolveTtlInputs(
      source.accessTokenPeriod,
      source.accessTokenTTL,
      source.accessTokenMaxTTL
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = computeIssuedTtl({
      requestedTTL,
      maxTTL: requestedMaxTTL,
      creationEpoch: source.creationEpoch,
      nowSeconds
    });
    if (ttl <= 0) {
      throw new UnauthorizedError({ message: "Cannot renew: identity access token has reached its max TTL" });
    }

    const numUsesLimit = decodedToken.numUsesLimit ?? 0;
    const ipRestrictionEnabled = Boolean(decodedToken.ipRestrictionEnabled);

    const { accessToken: renewedToken } = signIdentityAccessToken({
      identityAccessTokenId: decodedToken.identityAccessTokenId,
      identityId: decodedToken.identityId,
      identityName: source.identityName,
      authMethod: source.authMethod,
      orgId: source.orgId,
      rootOrgId: source.rootOrgId,
      parentOrgId: source.parentOrgId,
      clientSecretId: source.clientSecretId,
      numUsesLimit,
      ipRestrictionEnabled,
      ttlSeconds: ttl,
      identityAuth: source.identityAuth,
      accessTokenTTL: source.accessTokenTTL,
      accessTokenMaxTTL: source.accessTokenMaxTTL,
      accessTokenPeriod: source.accessTokenPeriod,
      creationEpoch: source.creationEpoch
    });

    // Renewed JWT keeps the same `jti`, so any existing revocation marker
    // already applies. Reseed the counter to the current remaining budget.
    if (numUsesLimit > 0) {
      const remainingUses = existingRemaining === null ? numUsesLimit : Math.max(0, existingRemaining);
      await keyStore.hashSetWithExpiry(
        stateKey,
        { [IdentityTokenStateFields.UsesRemaining(jti)]: remainingUses },
        appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
      );
    }

    return {
      accessToken: renewedToken,
      expiresIn: ttl,
      accessTokenMaxTTL: source.accessTokenMaxTTL
    };
  };

  const revokeAccessToken = async (accessToken: string) => {
    const appCfg = getConfig();

    const decodedToken = assertRevocableClaims(verifyAccessTokenJwt(accessToken));
    const { jti, identityId } = decodedToken;

    await keyStore.hashSetWithExpiry(
      KeyStorePrefixes.IdentityTokenState(identityId),
      { [IdentityTokenStateFields.UsesRemaining(jti)]: 0 },
      appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
    );

    void identityAccessTokenQueue.queuePgMirror({
      kind: "revoke-token",
      tokenId: decodedToken.identityAccessTokenId,
      identityId,
      expiresAt: new Date(
        (decodedToken.exp ?? decodedToken.iat + appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE) * 1000
      ).toISOString()
    });

    return { revokedToken: { id: decodedToken.identityAccessTokenId, identityId, isAccessTokenRevoked: true } };
  };

  // Per-token revoke from a context that doesn't have a JWT (e.g. Token Auth's
  // admin "revoke this token by id" flow). Caller computes the latest possible
  // exp and passes it as `expiresAt`; we skip the PG insert if it's already
  // in the past since no future JWT could be blocked by such a marker.
  const markPerTokenRevocation = async ({
    tokenId,
    identityId,
    expiresAt
  }: {
    tokenId: string;
    identityId: string;
    expiresAt: Date;
  }) => {
    const appCfg = getConfig();

    await keyStore.hashSetWithExpiry(
      KeyStorePrefixes.IdentityTokenState(identityId),
      { [IdentityTokenStateFields.UsesRemaining(tokenId)]: 0 },
      appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
    );

    if (expiresAt.getTime() <= Date.now()) {
      return;
    }

    await identityAccessTokenRevocationDAL.insertRevocation({
      id: tokenId,
      identityId,
      expiresAt
    });
  };

  // Identity-wide revoke: any JWT with iat < this epoch is rejected on auth.
  const revokeAllTokensForIdentity = async (identityId: string) => {
    const appCfg = getConfig();
    const revokedAt = new Date();

    await keyStore.hashSetWithExpiry(
      KeyStorePrefixes.IdentityTokenState(identityId),
      { [IdentityTokenStateFields.RevokedAfter]: revokedAt.toISOString() },
      appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
    );

    void identityAccessTokenQueue.queuePgMirror({
      kind: "revoke-all-for-identity",
      identityId,
      revokedAt: revokedAt.toISOString()
    });
  };

  const HYDRATION_LEASE_SECONDS = 600;
  const HYDRATION_MARKER_SECONDS = 2_592_000;

  const hydrateRedisFromPg = async () => {
    const acquired = await keyStore.setItemWithExpiryNX(
      KeyStorePrefixes.IdentityTokenHydrate,
      HYDRATION_LEASE_SECONDS,
      "in-progress"
    );
    if (acquired === null) {
      logger.info("identityAccessToken.hydrateRedisFromPg: skipped (another pod or already hydrated)");
      return;
    }

    const appCfg = getConfig();
    const BATCH_SIZE = 5_000;

    logger.info("identityAccessToken.hydrateRedisFromPg: starting Redis hydration from Postgres");

    let afterId: string | undefined;
    let totalTokens = 0;
    let totalIdentities = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Cursor pagination on id avoids MVCC drift across batches. The
        // expiresAt > NOW() filter inside the DAL drives partition pruning.
        // eslint-disable-next-line no-await-in-loop
        const rows = await identityAccessTokenRevocationDAL.findActive({ limit: BATCH_SIZE, afterId });

        if (rows.length === 0) {
          break;
        }

        const fieldsByIdentity = new Map<string, Record<string, string | number>>();
        for (const row of rows) {
          const bucket = fieldsByIdentity.get(row.identityId) ?? {};
          if (row.id === row.identityId) {
            bucket[IdentityTokenStateFields.RevokedAfter] = (row.revokedAt ?? row.createdAt).toISOString();
            totalIdentities += 1;
          } else {
            bucket[IdentityTokenStateFields.UsesRemaining(row.id)] = 0;
            totalTokens += 1;
          }
          fieldsByIdentity.set(row.identityId, bucket);
        }

        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(
          Array.from(fieldsByIdentity.entries()).map(async ([identityId, fields]) =>
            keyStore.hashSetWithExpiry(
              KeyStorePrefixes.IdentityTokenState(identityId),
              fields,
              appCfg.MAX_MACHINE_IDENTITY_TOKEN_AGE
            )
          )
        );

        if (rows.length < BATCH_SIZE) {
          break;
        }
        afterId = rows[rows.length - 1].id;
      }
    } catch (err) {
      logger.error(err, "identityAccessToken.hydrateRedisFromPg: failed during hydration");
      return;
    }

    // Promote the lease to a long-lived marker. Failure here is non-fatal: the
    // lease will expire and the next pod retries idempotently.
    await keyStore.setItemWithExpiry(KeyStorePrefixes.IdentityTokenHydrate, HYDRATION_MARKER_SECONDS, "complete");
    logger.info(
      `identityAccessToken.hydrateRedisFromPg: completed [tokenRevocations=${totalTokens}] [identityRevocations=${totalIdentities}]`
    );
  };

  return {
    issueIdentityAccessToken,
    renewAccessToken,
    revokeAccessToken,
    revokeAllTokensForIdentity,
    markPerTokenRevocation,
    fnValidateIdentityAccessTokenFast,
    hydrateRedisFromPg
  };
};
