import { IdentityAuthMethod } from "@app/db/schemas";

export type TRenewAccessTokenDTO = {
  accessToken: string;
};

export type TOidcAuthDetails = {
  claims: Record<string, string>;
};

export type TAWSAuthDetails = {
  accountId: string;
  arn: string;
  userId: string;

  // Derived from ARN
  partition: string; // "aws", "aws-gov", "aws-cn"
  service: string; // "iam", "sts"
  resourceType: string; // "user" or "role"
  resourceName: string;
};

export type TKubernetesAuthDetails = {
  namespace: string;
  name: string;
};

// Custom claims the identity access token JWT carries for stateless TTL/auth
// context. `jti`, `iat`, and `exp` come from the JWT spec — declared here for
// post-verify typing.
//
// `accessTokenTTL`, `accessTokenMaxTTL`, and `accessTokenPeriod` are mirrored
// into every renewed JWT so the renew flow can recompute caps without loading
// a token row (the row may not exist for non-Token-Auth methods under the
// lazy-insert model).
//
// `creationEpoch` anchors the maxTTL lifetime budget across renewals. JWT `iat`
// is restamped on every renewal, so it cannot anchor "since creation" — this
// claim is set at first issuance and copied through unchanged on renew.
export type TIdentityAccessTokenJwtPayload = {
  jti?: string;
  iat?: number;
  exp?: number;
  identityId: string;
  identityName?: string;
  authMethod?: IdentityAuthMethod;
  orgId?: string;
  rootOrgId?: string;
  parentOrgId?: string;
  numUsesLimit?: number;
  ipRestrictionEnabled?: boolean;
  clientSecretId: string;
  identityAccessTokenId: string;
  authTokenType: string;
  accessTokenTTL?: number;
  accessTokenMaxTTL?: number;
  accessTokenPeriod?: number;
  creationEpoch?: number;
  identityAuth: {
    oidc?: TOidcAuthDetails;
    kubernetes?: TKubernetesAuthDetails;
    aws?: TAWSAuthDetails;
  };
};

// Claims shared by every validated JWT path — the common core all three assert
// helpers require before they check their own additional fields.
export type TCoreTokenClaims = TIdentityAccessTokenJwtPayload & {
  jti: string;
  iat: number;
  identityId: string;
};

// Always present on legacy and new-format renewable JWTs. Renewals fall back
// to PG when the new-format claims (TRenewableClaims) aren't all present.
export type TMinimalRenewClaims = TCoreTokenClaims & {
  identityAccessTokenId: string;
};

// New-format JWTs carry these in addition to TMinimalRenewClaims, letting renew
// run without a PG read. `creationEpoch` anchors the maxTTL budget across renewals.
export type TRenewableClaims = TMinimalRenewClaims & {
  authMethod: IdentityAuthMethod;
  accessTokenTTL: number;
  accessTokenMaxTTL: number;
  accessTokenPeriod: number;
  creationEpoch: number;
};

// Claims required by the hot-path validator (fnValidateIdentityAccessTokenFast).
export type TFastPathClaims = TCoreTokenClaims & {
  orgId: string;
  rootOrgId: string;
  parentOrgId: string;
};

// Resolved renewal source — either parsed from new-format claims or loaded from
// PG for legacy upgrade. Same shape regardless of origin so the rest of renew
// is path-agnostic.
export type TRenewSource = {
  authMethod: IdentityAuthMethod;
  accessTokenTTL: number;
  accessTokenMaxTTL: number;
  accessTokenPeriod: number;
  creationEpoch: number;
  identityName: string;
  orgId: string;
  rootOrgId: string;
  parentOrgId: string;
  clientSecretId: string;
  identityAuth?: TIdentityAccessTokenJwtPayload["identityAuth"];
};

export type TRevocableClaims = TCoreTokenClaims & {
  authMethod: IdentityAuthMethod;
  accessTokenTTL: number;
};

export type TComputeIssuedTtlInput = {
  requestedTTL: number;
  maxTTL: number;
  creationEpoch: number;
  nowSeconds: number;
};

export type TSignIdentityAccessTokenInput = {
  identityAccessTokenId: string;
  identityId: string;
  identityName: string;
  authMethod: IdentityAuthMethod;
  orgId: string;
  rootOrgId: string;
  parentOrgId: string;
  clientSecretId: string;
  numUsesLimit: number;
  ipRestrictionEnabled: boolean;
  ttlSeconds: number;
  accessTokenTTL: number;
  accessTokenMaxTTL: number;
  accessTokenPeriod: number;
  creationEpoch: number;
  identityAuth?: {
    oidc?: TOidcAuthDetails;
    kubernetes?: TKubernetesAuthDetails;
    aws?: TAWSAuthDetails;
  };
};

export type TSignIdentityAccessTokenOutput = {
  accessToken: string;
  jti: string;
  expiresIn: number;
};
