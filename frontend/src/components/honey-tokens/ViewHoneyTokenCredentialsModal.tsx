import { ReactNode } from "react";

import { Modal, ModalContent, Spinner } from "@app/components/v2";
import { useGetHoneyTokenCredentials } from "@app/hooks/api/honeyTokens";
import { HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

import { AwsHoneyTokenCredentials } from "./ViewHoneyTokenCredentials/AwsHoneyTokenCredentials";

type Props = {
  honeyToken?: TDashboardHoneyToken;
  projectId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

const renderCredentials = (
  honeyToken: TDashboardHoneyToken,
  credentials: Record<string, string>
): ReactNode => {
  switch (honeyToken.type) {
    case HoneyTokenType.AWS:
      return (
        <AwsHoneyTokenCredentials
          secretsMapping={honeyToken.secretsMapping}
          credentials={credentials}
        />
      );
    default:
      throw new Error("Unhandled honey token type");
  }
};

const ModalBody = ({
  honeyToken,
  projectId,
  isOpen
}: {
  honeyToken?: TDashboardHoneyToken;
  projectId: string;
  isOpen: boolean;
}) => {
  const { data: credentials, isPending } = useGetHoneyTokenCredentials({
    honeyTokenId: honeyToken?.id ?? "",
    projectId,
    enabled: isOpen && Boolean(honeyToken)
  });

  if (isPending) {
    return (
      <div className="flex flex-col items-center justify-center py-4">
        <Spinner size="lg" className="text-mineshaft-500" />
        <p className="mt-4 text-sm text-mineshaft-400">Loading credentials...</p>
      </div>
    );
  }

  if (credentials && honeyToken) {
    return renderCredentials(honeyToken, credentials);
  }

  return <p className="text-sm text-red">No credentials found for this honey token.</p>;
};

export const ViewHoneyTokenCredentialsModal = ({
  honeyToken,
  projectId,
  isOpen,
  onOpenChange
}: Props) => {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        title="Generated Credentials"
        subTitle={honeyToken ? `View the credentials for "${honeyToken.name}".` : ""}
      >
        <ModalBody honeyToken={honeyToken} projectId={projectId} isOpen={isOpen} />
      </ModalContent>
    </Modal>
  );
};
