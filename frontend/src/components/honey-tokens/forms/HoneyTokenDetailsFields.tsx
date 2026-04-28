import { Controller, useFormContext } from "react-hook-form";

import { FormControl, Input, TextArea } from "@app/components/v2";

import { THoneyTokenForm } from "./schemas";

export const HoneyTokenDetailsFields = () => {
  const { control } = useFormContext<THoneyTokenForm>();

  return (
    <>
      <p className="mb-4 text-sm text-bunker-300">
        Provide a name and description for this honey token.
      </p>
      <Controller
        render={({ field: { value, onChange }, fieldState: { error } }) => (
          <FormControl
            helperText="Must be slug-friendly"
            isError={Boolean(error)}
            errorText={error?.message}
            label="Name"
          >
            <Input autoFocus value={value} onChange={onChange} placeholder="aws-canary-prod-key" />
          </FormControl>
        )}
        control={control}
        name="name"
      />
      <Controller
        render={({ field: { value, onChange }, fieldState: { error } }) => (
          <FormControl
            isError={Boolean(error)}
            isOptional
            errorText={error?.message}
            label="Description"
          >
            <TextArea
              value={value ?? ""}
              onChange={onChange}
              placeholder="Describe where this decoy is planted and who should respond..."
              className="resize-none!"
              rows={4}
            />
          </FormControl>
        )}
        control={control}
        name="description"
      />
    </>
  );
};
