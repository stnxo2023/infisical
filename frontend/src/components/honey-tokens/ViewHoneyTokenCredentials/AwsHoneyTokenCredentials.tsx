import { CredentialDisplay } from "@app/components/secret-rotations-v2/ViewSecretRotationV2GeneratedCredentials/shared/CredentialDisplay";
import { TAwsHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  secretsMapping: TAwsHoneyToken["secretsMapping"];
  credentials: Record<string, string>;
};

const CREDENTIAL_FIELDS: { key: keyof TAwsHoneyToken["secretsMapping"]; label: string }[] = [
  { key: "accessKeyId", label: "Access Key ID" },
  { key: "secretAccessKey", label: "Secret Access Key" }
];

export const AwsHoneyTokenCredentials = ({ secretsMapping, credentials }: Props) => {
  return (
    <div className="flex flex-col gap-x-8 gap-y-2 rounded-sm border border-mineshaft-600 bg-mineshaft-700 p-2">
      {CREDENTIAL_FIELDS.map(({ key, label }) => {
        const secretName = secretsMapping[key];
        const value = secretName ? credentials[secretName] : undefined;

        return (
          <CredentialDisplay key={key} label={label} isSensitive>
            {value}
          </CredentialDisplay>
        );
      })}
    </div>
  );
};
