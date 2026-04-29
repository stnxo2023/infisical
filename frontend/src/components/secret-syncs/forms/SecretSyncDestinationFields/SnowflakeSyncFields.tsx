import { Controller, useFormContext } from "react-hook-form";

import { SecretSyncConnectionField } from "@app/components/secret-syncs/forms/SecretSyncConnectionField";
import { FormControl, Input } from "@app/components/v2";
import { SecretSync } from "@app/hooks/api/secretSyncs";

import { TSecretSyncForm } from "../schemas";

export const SnowflakeSyncFields = () => {
  const { control, setValue } = useFormContext<
    TSecretSyncForm & { destination: SecretSync.Snowflake }
  >();

  return (
    <>
      <SecretSyncConnectionField
        onChange={() => {
          setValue("destinationConfig.database", "");
          setValue("destinationConfig.schema", "");
        }}
      />

      <Controller
        name="destinationConfig.database"
        control={control}
        render={({ field: { value, onChange }, fieldState: { error } }) => (
          <FormControl
            isError={Boolean(error)}
            errorText={error?.message}
            label="Database"
            tooltipClassName="max-w-sm"
            tooltipText="The name of the Snowflake database that contains the target schema. The database must already exist."
          >
            <Input value={value} onChange={onChange} placeholder="MY_DATABASE" />
          </FormControl>
        )}
      />

      <Controller
        name="destinationConfig.schema"
        control={control}
        render={({ field: { value, onChange }, fieldState: { error } }) => (
          <FormControl
            isError={Boolean(error)}
            errorText={error?.message}
            label="Schema"
            tooltipClassName="max-w-sm"
            tooltipText="The name of the Snowflake schema (within the selected database) where secrets will be created. The schema must already exist."
          >
            <Input value={value} onChange={onChange} placeholder="MY_SCHEMA" />
          </FormControl>
        )}
      />
    </>
  );
};
