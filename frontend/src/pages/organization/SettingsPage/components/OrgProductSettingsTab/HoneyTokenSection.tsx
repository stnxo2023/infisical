import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { faCheck, faCopy, faEye, faEyeSlash, faTerminal } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { createNotification } from "@app/components/notifications";
import { OrgPermissionCan } from "@app/components/permissions";
import {
  Button,
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FilterableSelect,
  IconButton
} from "@app/components/v3";
import { OrgPermissionActions, OrgPermissionSubjects, useOrganization } from "@app/context";
import { useTimedReset, useToggle } from "@app/hooks";
import { AppConnection } from "@app/hooks/api/appConnections/enums";
import { useListAppConnections } from "@app/hooks/api/appConnections/queries";
import {
  HoneyTokenType,
  useGetHoneyTokenConfig,
  useUpsertHoneyTokenConfig
} from "@app/hooks/api/honeyToken";

const CF_TEMPLATE_URL =
  "https://s3.amazonaws.com/infisical-honeytokens/cfn/aws-honey-token-v1.yaml";

const schema = z.object({
  connectionId: z.string().min(1, "AWS Connection is required"),
  secretToken: z.string().min(1, "Secret Token is required")
});

type FormData = z.infer<typeof schema>;

export const HoneyTokenSection = () => {
  const { currentOrg } = useOrganization();
  const [isTokenVisible, setIsTokenVisible] = useToggle(false);
  const [, isTokenCopied, setTokenCopied] = useTimedReset({ initialState: false });
  const [, isCommandCopied, setCommandCopied] = useTimedReset({ initialState: false });

  const { data: appConnections = [], isPending: isLoadingConnections } = useListAppConnections();
  const { data: existingConfig } = useGetHoneyTokenConfig(HoneyTokenType.AWS, {
    retry: false
  });
  const { mutateAsync: upsertConfig, isPending: isSaving } = useUpsertHoneyTokenConfig();

  const awsConnections = useMemo(
    () => appConnections.filter((conn) => conn.app === AppConnection.AWS),
    [appConnections]
  );

  const webhookUrl = useMemo(() => {
    const { protocol, host } = window.location;
    return `${protocol}//${host}/api/v1/honey-tokens/${currentOrg?.id}/trigger`;
  }, [currentOrg?.id]);

  const { control, handleSubmit, watch, reset } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      connectionId: "",
      secretToken: ""
    }
  });

  useEffect(() => {
    if (!existingConfig?.decryptedConfig) return;

    reset({
      connectionId: existingConfig.connectionId ?? "",
      secretToken: existingConfig.decryptedConfig.secretToken
    });
  }, [existingConfig, reset]);

  const secretToken = watch("secretToken");

  const cfCommand = useMemo(
    () =>
      [
        "aws cloudformation create-stack \\",
        "  --region us-east-1 \\",
        "  --stack-name infisical-honey-tokens \\",
        `  --template-url ${CF_TEMPLATE_URL} \\`,
        "  --capabilities CAPABILITY_NAMED_IAM \\",
        "  --parameters \\",
        `    ParameterKey=WebhookUrl,ParameterValue=${webhookUrl} \\`,
        `    ParameterKey=WebhookSigningKey,ParameterValue=${secretToken}`
      ].join("\n"),
    [secretToken, webhookUrl]
  );

  const onSubmit = async (data: FormData) => {
    try {
      await upsertConfig({
        type: HoneyTokenType.AWS,
        connectionId: data.connectionId,
        config: {
          secretToken: data.secretToken
        }
      });
      createNotification({
        text: "Honey token settings saved successfully",
        type: "success"
      });
    } catch {
      createNotification({
        text: "Failed to save honey token settings",
        type: "error"
      });
    }
  };

  return (
    <div className="mb-6 rounded-lg border border-mineshaft-600 bg-mineshaft-900 p-6">
      <div className="mb-4">
        <h2 className="text-xl font-medium text-mineshaft-100">Honey Token Settings</h2>
        <p className="mt-1 text-sm text-mineshaft-400">
          Plant a decoy IAM credential in your AWS account. Infisical alerts on every access
          attempt.
        </p>
      </div>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="mb-4 flex gap-4">
          <div className="flex-1">
            <Controller
              control={control}
              name="connectionId"
              render={({ field, fieldState: { error } }) => {
                const selectedConnection = awsConnections.find((conn) => conn.id === field.value);

                return (
                  <Field>
                    <FieldLabel>App Connection</FieldLabel>
                    <FieldContent>
                      <FilterableSelect
                        value={selectedConnection || null}
                        onChange={(newValue) => {
                          const singleValue = Array.isArray(newValue) ? newValue[0] : newValue;
                          if (singleValue && "id" in singleValue) {
                            field.onChange(singleValue.id);
                          } else {
                            field.onChange("");
                          }
                        }}
                        isError={Boolean(error)}
                        isLoading={isLoadingConnections}
                        options={awsConnections}
                        placeholder="Select an AWS App Connection..."
                        getOptionLabel={(option) => option.name}
                        getOptionValue={(option) => option.id}
                      />
                      <FieldError errors={[error]} />
                    </FieldContent>
                  </Field>
                );
              }}
            />
          </div>
          <div className="flex-1">
            <Field>
              <FieldLabel>Secret Token</FieldLabel>
              <FieldContent>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-mineshaft-500 bg-mineshaft-900 px-3 font-mono text-sm text-bunker-200">
                    {isTokenVisible ? secretToken : "•".repeat(30)}
                  </div>
                  <IconButton
                    aria-label="toggle secret token visibility"
                    variant="outline"
                    size="md"
                    onClick={() => setIsTokenVisible.toggle()}
                  >
                    <FontAwesomeIcon icon={isTokenVisible ? faEyeSlash : faEye} />
                  </IconButton>
                  <IconButton
                    aria-label="copy secret token"
                    variant="outline"
                    size="md"
                    onClick={() => {
                      navigator.clipboard.writeText(secretToken);
                      setTokenCopied(true);
                    }}
                  >
                    <FontAwesomeIcon icon={isTokenCopied ? faCheck : faCopy} />
                  </IconButton>
                </div>
              </FieldContent>
            </Field>
          </div>
        </div>

        <div className="mb-4 rounded-md border border-mineshaft-600 bg-bunker-800 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-mineshaft-300">
            <FontAwesomeIcon icon={faTerminal} className="text-mineshaft-400" />
            <span className="font-medium tracking-wide uppercase">Deploy CloudFormation Stack</span>
          </div>
          <p className="mb-3 text-sm text-mineshaft-400">
            Run this command to create the CloudFormation stack that provisions the decoy IAM user
            and wires CloudTrail alerts back to Infisical.
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-black/40 p-4 pr-12 font-mono text-xs leading-relaxed text-mineshaft-200">
              <span className="text-mineshaft-500 select-none">$ </span>
              {cfCommand}
            </pre>
            <IconButton
              aria-label="copy CloudFormation command"
              variant="outline"
              size="xs"
              className="absolute top-2 right-2"
              onClick={() => {
                navigator.clipboard.writeText(cfCommand);
                setCommandCopied(true);
              }}
            >
              <FontAwesomeIcon icon={isCommandCopied ? faCheck : faCopy} />
            </IconButton>
          </div>
        </div>

        <div className="flex justify-end">
          <OrgPermissionCan I={OrgPermissionActions.Edit} a={OrgPermissionSubjects.Settings}>
            {(isAllowed) => (
              <Button
                type="submit"
                variant="outline"
                isPending={isSaving}
                isDisabled={!isAllowed || isSaving}
              >
                Save
              </Button>
            )}
          </OrgPermissionCan>
        </div>
      </form>
    </div>
  );
};
