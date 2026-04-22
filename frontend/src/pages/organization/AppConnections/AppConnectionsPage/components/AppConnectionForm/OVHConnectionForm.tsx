import { Controller, FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Button,
  FormControl,
  Input,
  ModalClose,
  SecretInput,
  Select,
  SelectItem
} from "@app/components/v2";
import { APP_CONNECTION_MAP, getAppConnectionMethodDetails } from "@app/helpers/appConnections";
import { AppConnection } from "@app/hooks/api/appConnections/enums";
import {
  OVHConnectionMethod,
  TOvhConnection
} from "@app/hooks/api/appConnections/types/ovh-connection";
import { isBase64 } from "@app/lib/fn/base64";

import {
  genericAppConnectionFieldsSchema,
  GenericAppConnectionsFields
} from "./GenericAppConnectionFields";

type Props = {
  appConnection?: TOvhConnection;
  onSubmit: (formData: FormData) => void;
};

const rootSchema = genericAppConnectionFieldsSchema.extend({
  app: z.literal(AppConnection.OVH)
});

const formSchema = z.discriminatedUnion("method", [
  rootSchema.extend({
    method: z.literal(OVHConnectionMethod.Pkcs12Certificate),
    credentials: z.object({
      pkcs12Certificate: z
        .string()
        .trim()
        .min(1, "PKCS#12 certificate required")
        .refine(isBase64, { message: "Value must be a valid base64 string" }),
      pkcs12Passphrase: z.string().optional(),
      okmsDomain: z.string().trim().min(1, "OKMS domain required"),
      okmsId: z.string().trim().min(1, "OKMS ID required")
    })
  })
]);

type FormData = z.infer<typeof formSchema>;

export const OVHConnectionForm = ({ appConnection, onSubmit }: Props) => {
  const isUpdate = Boolean(appConnection);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: appConnection
      ? {
          ...appConnection,
          credentials: {
            ...appConnection.credentials,
            pkcs12Certificate: "",
            pkcs12Passphrase: ""
          }
        }
      : {
          app: AppConnection.OVH,
          method: OVHConnectionMethod.Pkcs12Certificate,
          credentials: {
            pkcs12Certificate: "",
            pkcs12Passphrase: "",
            okmsDomain: "",
            okmsId: ""
          }
        }
  });

  const {
    handleSubmit,
    control,
    formState: { isSubmitting, isDirty }
  } = form;

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit(onSubmit)}>
        {!isUpdate && <GenericAppConnectionsFields />}
        <Controller
          name="method"
          control={control}
          render={({ field: { value, onChange }, fieldState: { error } }) => (
            <FormControl
              tooltipText={`The method you would like to use to connect with ${
                APP_CONNECTION_MAP[AppConnection.OVH].name
              }. This field cannot be changed after creation.`}
              errorText={error?.message}
              isError={Boolean(error?.message)}
              label="Method"
            >
              <Select
                isDisabled={isUpdate}
                value={value}
                onValueChange={(val) => onChange(val)}
                className="w-full border border-mineshaft-500"
                position="popper"
                dropdownContainerClassName="max-w-none"
              >
                {Object.values(OVHConnectionMethod).map((method) => (
                  <SelectItem value={method} key={method}>
                    {getAppConnectionMethodDetails(method).name}
                  </SelectItem>
                ))}
              </Select>
            </FormControl>
          )}
        />
        <Controller
          name="credentials.pkcs12Certificate"
          control={control}
          shouldUnregister
          render={({ field: { value, onChange }, fieldState: { error } }) => (
            <FormControl
              errorText={error?.message}
              isError={Boolean(error?.message)}
              label="PKCS#12 Certificate (Base64)"
              helperText={
                isUpdate
                  ? "Paste the base64-encoded PKCS#12 bundle to replace the existing certificate. Generate it locally with: base64 -w 0 cert.p12"
                  : "Paste the base64-encoded contents of your .p12/.pfx bundle. Generate it locally with: base64 -w 0 cert.p12"
              }
              tooltipText="The PKCS#12 bundle must be base64-encoded (no line breaks). It will be used for mTLS authentication with OVH OKMS."
            >
              <SecretInput
                containerClassName="text-gray-400 group-focus-within:border-primary-400/50! border border-mineshaft-500 bg-mineshaft-900 px-2.5 py-1.5"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
            </FormControl>
          )}
        />
        <Controller
          name="credentials.pkcs12Passphrase"
          control={control}
          shouldUnregister
          render={({ field: { value, onChange }, fieldState: { error } }) => (
            <FormControl
              errorText={error?.message}
              isError={Boolean(error?.message)}
              label="PKCS#12 Passphrase"
              isOptional
              tooltipText="The passphrase set when exporting the PKCS#12 bundle. Leave empty if the bundle has no passphrase."
            >
              <SecretInput
                containerClassName="text-gray-400 group-focus-within:border-primary-400/50! border border-mineshaft-500 bg-mineshaft-900 px-2.5 py-1.5"
                value={value ?? ""}
                onChange={(e) => onChange(e.target.value)}
              />
            </FormControl>
          )}
        />
        <Controller
          name="credentials.okmsDomain"
          control={control}
          shouldUnregister
          render={({ field, fieldState: { error } }) => (
            <FormControl
              errorText={error?.message}
              isError={Boolean(error?.message)}
              label="OKMS Domain"
              helperText="Include the host and any path prefix. The OKMS ID and API version are appended automatically."
              tooltipText="The OKMS base URL, e.g. 'https://ca-east-bhs.okms.ovh.net/api'."
            >
              <Input {...field} placeholder="https://ca-east-bhs.okms.ovh.net/api" />
            </FormControl>
          )}
        />
        <Controller
          name="credentials.okmsId"
          control={control}
          shouldUnregister
          render={({ field, fieldState: { error } }) => (
            <FormControl
              errorText={error?.message}
              isError={Boolean(error?.message)}
              label="OKMS ID"
              helperText="Your OKMS instance identifier from the OVH Control Panel."
            >
              <Input {...field} placeholder="your-okms-instance-id" />
            </FormControl>
          )}
        />
        <div className="mt-8 flex items-center">
          <Button
            className="mr-4"
            size="sm"
            type="submit"
            colorSchema="secondary"
            isLoading={isSubmitting}
            isDisabled={isSubmitting || !isDirty}
          >
            {isUpdate ? "Update Credentials" : "Connect to OVH"}
          </Button>
          <ModalClose asChild>
            <Button colorSchema="secondary" variant="plain">
              Cancel
            </Button>
          </ModalClose>
        </div>
      </form>
    </FormProvider>
  );
};
