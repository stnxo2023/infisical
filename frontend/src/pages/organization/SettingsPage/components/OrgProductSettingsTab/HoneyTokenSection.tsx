import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { faCopy, faEye, faEyeSlash, faTerminal } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { createNotification } from "@app/components/notifications";
import { OrgPermissionCan } from "@app/components/permissions";
import { Button, FilterableSelect, FormControl, IconButton } from "@app/components/v2";
import { OrgPermissionActions, OrgPermissionSubjects, useOrganization } from "@app/context";
import { useToggle } from "@app/hooks";
import { AppConnection } from "@app/hooks/api/appConnections/enums";
import { useListAppConnections } from "@app/hooks/api/appConnections/queries";

const CF_TEMPLATE_URL =
  "https://s3.amazonaws.com/infisical-honeytokens/cfn/aws-honey-token-v1.yaml";

const generateSecretToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `htk_live_${hex}`;
};

const schema = z.object({
  connectionId: z.string().min(1, "AWS Connection is required"),
  secretToken: z.string().min(1, "Secret Token is required")
});

type FormData = z.infer<typeof schema>;

export const HoneyTokenSection = () => {
  const { currentOrg } = useOrganization();
  const [isTokenVisible, setIsTokenVisible] = useToggle(false);
  const [isSaving, setIsSaving] = useState(false);

  const { data: appConnections = [], isPending: isLoadingConnections } = useListAppConnections();

  const awsConnections = useMemo(
    () => appConnections.filter((conn) => conn.app === AppConnection.AWS),
    [appConnections]
  );

  const webhookUrl = useMemo(() => {
    const { protocol, host } = window.location;
    return `${protocol}//${host}/api/v1/honey-tokens/${currentOrg?.id}/trigger`;
  }, [currentOrg?.id]);

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors }
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      connectionId: "",
      secretToken: ""
    }
  });

  useEffect(() => {
    setValue("secretToken", generateSecretToken());
  }, [setValue]);

  const secretToken = watch("secretToken");

  const cfCommand = useMemo(
    () =>
      [
        "aws cloudformation create-stack \\",
        "  --stack-name infisical-honey-tokens \\",
        `  --template-url ${CF_TEMPLATE_URL} \\`,
        "  --capabilities CAPABILITY_NAMED_IAM \\",
        "  --parameters \\",
        `    ParameterKey=SecretToken,ParameterValue=${secretToken} \\`,
        `    ParameterKey=WebhookUrl,ParameterValue=${webhookUrl}`
      ].join("\n"),
    [secretToken, webhookUrl]
  );

  const onSubmit = async (data: FormData) => {
    setIsSaving(true);
    try {
      // TODO: call backend API to save honey token config with data + webhookUrl
      console.log("Honey token config", { ...data, webhookUrl });
      createNotification({
        text: "Honey token settings saved successfully",
        type: "success"
      });
    } finally {
      setIsSaving(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    createNotification({ text: `${label} copied to clipboard`, type: "info" });
  };

  return (
    <div className="mb-6 rounded-lg border border-mineshaft-600 bg-mineshaft-900 p-6">
      <div className="mb-4">
        <h2 className="text-xl font-medium text-mineshaft-100">Honey Token Settings</h2>
        <p className="mt-1 text-sm text-mineshaft-400">
          Plant a decoy IAM credential in your AWS account. Infisical alerts on every access attempt
          via CloudTrail.
        </p>
      </div>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="mb-4 flex gap-4">
          <div className="flex-1">
            <Controller
              control={control}
              name="connectionId"
              render={({ field }) => {
                const selectedConnection = awsConnections.find((conn) => conn.id === field.value);

                return (
                  <FormControl
                    label="App Connection"
                    isError={Boolean(errors.connectionId)}
                    errorText={errors.connectionId?.message}
                  >
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
                      isLoading={isLoadingConnections}
                      options={awsConnections}
                      placeholder="Select an AWS App Connection..."
                      getOptionLabel={(option) => option.name}
                      getOptionValue={(option) => option.id}
                    />
                  </FormControl>
                );
              }}
            />
          </div>
          <div className="flex-1">
            <FormControl label="Secret Token">
              <div className="flex items-center gap-2">
                <div className="flex-1 overflow-hidden rounded-md border border-mineshaft-500 bg-mineshaft-900 px-3 py-[0.44rem] font-mono text-sm text-bunker-200">
                  {isTokenVisible ? secretToken : "•".repeat(30)}
                </div>
                <IconButton
                  ariaLabel="toggle secret token visibility"
                  variant="outline_bg"
                  size="sm"
                  onClick={() => setIsTokenVisible.toggle()}
                >
                  <FontAwesomeIcon icon={isTokenVisible ? faEyeSlash : faEye} />
                </IconButton>
                <IconButton
                  ariaLabel="copy secret token"
                  variant="outline_bg"
                  size="sm"
                  onClick={() => copyToClipboard(secretToken, "Secret token")}
                >
                  <FontAwesomeIcon icon={faCopy} />
                </IconButton>
              </div>
            </FormControl>
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
              ariaLabel="copy CloudFormation command"
              variant="outline_bg"
              size="xs"
              className="absolute top-2 right-2"
              onClick={() => copyToClipboard(cfCommand, "Command")}
            >
              <FontAwesomeIcon icon={faCopy} />
            </IconButton>
          </div>
        </div>

        <div className="flex justify-end">
          <OrgPermissionCan I={OrgPermissionActions.Edit} a={OrgPermissionSubjects.Settings}>
            {(isAllowed) => (
              <Button
                type="submit"
                colorSchema="primary"
                isLoading={isSaving}
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
