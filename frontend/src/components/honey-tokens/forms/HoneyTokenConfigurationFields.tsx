import { Controller, useFormContext } from "react-hook-form";

import { FilterableSelect, FormControl } from "@app/components/v2";
import { ProjectEnv } from "@app/hooks/api/projects/types";

import { THoneyTokenForm } from "./schemas";

type Props = {
  environments?: ProjectEnv[];
};

export const HoneyTokenConfigurationFields = ({ environments }: Props) => {
  const { control } = useFormContext<THoneyTokenForm>();

  return (
    <>
      <p className="mb-4 text-sm text-bunker-300">Select where to plant the honey token secrets.</p>
      {environments && (
        <Controller
          control={control}
          name="environment"
          render={({ field: { value, onChange }, fieldState: { error } }) => (
            <FormControl label="Environment" isError={Boolean(error)} errorText={error?.message}>
              <FilterableSelect
                value={value}
                onChange={onChange}
                options={environments}
                placeholder="Select an environment..."
                getOptionLabel={(option) => option?.name}
                getOptionValue={(option) => option?.id}
              />
            </FormControl>
          )}
        />
      )}
    </>
  );
};
