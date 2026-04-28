import { createNotification } from "@app/components/notifications";
import { DeleteActionModal } from "@app/components/v2";
import { useDeleteHoneyToken } from "@app/hooks/api/honeyTokens";
import { TDashboardHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  honeyToken?: TDashboardHoneyToken;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

export const DeleteHoneyTokenModal = ({ isOpen, onOpenChange, honeyToken }: Props) => {
  const deleteHoneyToken = useDeleteHoneyToken();

  if (!honeyToken) return null;

  const handleDelete = async () => {
    await deleteHoneyToken.mutateAsync({
      honeyTokenId: honeyToken.id,
      projectId: honeyToken.projectId
    });

    createNotification({
      text: `Successfully deleted honey token "${honeyToken.name}"`,
      type: "success"
    });

    onOpenChange(false);
  };

  return (
    <DeleteActionModal
      isOpen={isOpen}
      onChange={onOpenChange}
      title={`Are you sure you want to delete ${honeyToken.name}?`}
      subTitle="This will revoke the AWS IAM credentials and remove the associated decoy secrets from this environment."
      deleteKey={honeyToken.name}
      onDeleteApproved={handleDelete}
    />
  );
};
