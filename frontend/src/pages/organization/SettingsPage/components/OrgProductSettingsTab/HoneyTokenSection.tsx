import { createNotification } from "@app/components/notifications";
import { OrgPermissionCan } from "@app/components/permissions";
import { Button } from "@app/components/v3";
import { OrgPermissionActions, OrgPermissionSubjects } from "@app/context";
import { usePopUp } from "@app/hooks";
import {
  HoneyTokenType,
  useGetHoneyTokenConfig,
  useTestHoneyTokenConnection
} from "@app/hooks/api/honeyToken";

import { HoneyTokenModal } from "./HoneyTokenModal";

export const HoneyTokenSection = () => {
  const { popUp, handlePopUpOpen, handlePopUpToggle } = usePopUp(["honeyTokenModal"] as const);

  const { data: existingConfig } = useGetHoneyTokenConfig(HoneyTokenType.AWS, {
    retry: false
  });
  const { mutateAsync: testConnection, isPending: isTesting } = useTestHoneyTokenConnection();

  const isConfigured = Boolean(existingConfig?.id);

  const handleTestConnection = async () => {
    try {
      const result = await testConnection(HoneyTokenType.AWS);
      if (result.isConnected) {
        createNotification({
          text: `CloudFormation stack "${result.stackName}" is deployed and healthy.`,
          type: "success"
        });
      } else {
        createNotification({
          text: result.status
            ? `Stack "${result.stackName}" is not ready (status: ${result.status}).`
            : `Stack "${result.stackName}" was not found. Deploy the stack first.`,
          type: "error"
        });
      }
    } catch {
      createNotification({
        text: "Failed to test connection. Check your AWS App Connection permissions.",
        type: "error"
      });
    }
  };

  return (
    <div className="mt-6 border-t border-mineshaft-600 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-mineshaft-100">AWS Honey Tokens</h3>
          <p className="mt-1 text-sm text-mineshaft-400">
            Plant decoy IAM credentials in your AWS account. Infisical alerts on every access
            attempt.
          </p>
        </div>
        <OrgPermissionCan I={OrgPermissionActions.Edit} a={OrgPermissionSubjects.Settings}>
          {(isAllowed) => (
            <div className="flex gap-2">
              {isConfigured && (
                <Button
                  variant="outline"
                  isDisabled={!isAllowed || isTesting}
                  isPending={isTesting}
                  onClick={handleTestConnection}
                >
                  Test Connection
                </Button>
              )}
              <Button
                colorSchema={isConfigured ? "secondary" : "primary"}
                isDisabled={!isAllowed}
                onClick={() => handlePopUpOpen("honeyTokenModal")}
              >
                {isConfigured ? "Manage" : "Connect"}
              </Button>
            </div>
          )}
        </OrgPermissionCan>
      </div>
      <HoneyTokenModal
        isOpen={popUp.honeyTokenModal.isOpen}
        onOpenChange={(isOpen) => handlePopUpToggle("honeyTokenModal", isOpen)}
      />
    </div>
  );
};
