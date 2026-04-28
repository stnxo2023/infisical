import { HoneyTokenForm } from "@app/components/honey-tokens/forms";
import { HoneyTokenModalHeader } from "@app/components/honey-tokens/HoneyTokenModalHeader";
import { Modal, ModalContent } from "@app/components/v2";
import { HoneyTokenType, TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  honeyToken?: TDashboardHoneyToken;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

export const EditHoneyTokenModal = ({ isOpen, onOpenChange, honeyToken }: Props) => {
  if (!honeyToken) return null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent
        title={<HoneyTokenModalHeader type={honeyToken.type as HoneyTokenType} isEdit />}
        className="max-w-2xl"
        bodyClassName="overflow-visible"
      >
        <HoneyTokenForm
          onComplete={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
          honeyToken={honeyToken}
          type={honeyToken.type as HoneyTokenType}
          secretPath={honeyToken.folder.path}
          environment={honeyToken.environment.slug}
        />
      </ModalContent>
    </Modal>
  );
};
