import { CredentialDisplay } from "@app/components/secret-rotations-v2/ViewSecretRotationV2GeneratedCredentials/shared/CredentialDisplay";
import { ViewRotationGeneratedCredentialsDisplay } from "@app/components/secret-rotations-v2/ViewSecretRotationV2GeneratedCredentials/shared/ViewRotationGeneratedCredentialsDisplay";
import { Modal, ModalContent, Spinner } from "@app/components/v2";
import { HONEY_TOKEN_CREDENTIAL_FIELDS } from "@app/helpers/honeyTokens";
import { useGetHoneyTokenCredentials } from "@app/hooks/api/honeyTokens";
import { HoneyTokenType, TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  honeyToken?: TDashboardHoneyToken;
  projectId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

export const ViewHoneyTokenCredentialsModal = ({
  honeyToken,
  projectId,
  isOpen,
  onOpenChange
}: Props) => {
  const { data: credentials, isPending } = useGetHoneyTokenCredentials({
    honeyTokenId: honeyToken?.id ?? "",
    projectId,
    enabled: isOpen && Boolean(honeyToken)
  });

  const credentialFields = honeyToken
    ? HONEY_TOKEN_CREDENTIAL_FIELDS[honeyToken.type as HoneyTokenType]
    : [];

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        title="Generated Credentials"
        subTitle={honeyToken ? `View the credentials for "${honeyToken.name}".` : ""}
      >
        {isPending ? (
          <div className="flex flex-col items-center justify-center py-4">
            <Spinner size="lg" className="text-mineshaft-500" />
            <p className="mt-4 text-sm text-mineshaft-400">Loading credentials...</p>
          </div>
        ) : credentials ? (
          <ViewRotationGeneratedCredentialsDisplay
            activeCredentials={
              <>
                {credentialFields.map(({ key, label }) => {
                  const secretName = honeyToken?.secretsMapping?.[key];
                  const value = secretName ? credentials[secretName] : undefined;

                  return (
                    <CredentialDisplay
                      key={key}
                      label={label}
                      isSensitive
                    >
                      {value}
                    </CredentialDisplay>
                  );
                })}
              </>
            }
          />
        ) : (
          <p className="text-sm text-red">No credentials found for this honey token.</p>
        )}
      </ModalContent>
    </Modal>
  );
};
