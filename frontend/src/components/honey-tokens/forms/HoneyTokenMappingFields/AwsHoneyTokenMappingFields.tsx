import { Controller, useFormContext } from "react-hook-form";
import { faArrowRight, faKey, faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { InfoIcon } from "lucide-react";

import {
  Badge,
  FieldError,
  Input,
  Label,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@app/components/v3";
import { HONEY_TOKEN_DEFAULT_SECRET_NAMES } from "@app/helpers/honeyTokens";
import { HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";

import { THoneyTokenForm } from "../schemas";

export const AwsHoneyTokenMappingFields = () => {
  const {
    control,
    formState: { errors }
  } = useFormContext<THoneyTokenForm & { type: HoneyTokenType.AWS }>();

  const mappingError = errors.secretsMapping?.message;

  const defaults = HONEY_TOKEN_DEFAULT_SECRET_NAMES[HoneyTokenType.AWS];

  const items = [
    {
      name: "Access Key ID",
      icon: faKey,
      fieldName: "secretsMapping.accessKeyId" as const,
      placeholder: defaults.accessKeyId
    },
    {
      name: "Secret Access Key",
      icon: faLock,
      fieldName: "secretsMapping.secretAccessKey" as const,
      placeholder: defaults.secretAccessKey
    }
  ];

  return (
    <div className="w-full overflow-hidden">
      <table className="w-full table-auto">
        <thead>
          <tr className="text-left">
            <th className="whitespace-nowrap pb-3">
              <Label className="text-xs">Decoy Credential</Label>
            </th>
            <th className="pb-3" />
            <th className="pb-3">
              <div className="flex items-center gap-1">
                <Label className="text-xs">Secret Name</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="text-muted-foreground size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    The name of the secret that the decoy credential will be mapped to in your
                    project.
                  </TooltipContent>
                </Tooltip>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ name, icon, fieldName, placeholder }) => (
            <tr key={name}>
              <td className="whitespace-nowrap">
                <div className="mb-4 flex h-full items-start justify-center">
                  <Badge variant="neutral" className="h-[36px] w-full justify-center text-xs">
                    <FontAwesomeIcon icon={icon} />
                    {name}
                  </Badge>
                </div>
              </td>
              <td className="pr-5 pl-5 whitespace-nowrap">
                <div className="mb-4 flex items-center justify-center">
                  <FontAwesomeIcon className="text-mineshaft-400" icon={faArrowRight} />
                </div>
              </td>
              <td className="w-full">
                <Controller
                  render={({ field: { value, onChange }, fieldState: { error } }) => (
                    <div className="mb-4">
                      <div className="relative">
                        <Input
                          value={value}
                          onChange={onChange}
                          placeholder={placeholder}
                          isError={Boolean(error)}
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
                          <Badge variant="warning" className="text-[10px]">
                            Decoy
                          </Badge>
                        </span>
                      </div>
                      {error && <FieldError>{error.message}</FieldError>}
                    </div>
                  )}
                  control={control}
                  name={fieldName}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mappingError && (
        <div className="mt-2 rounded-sm border border-red/40 bg-red/10 p-3 text-xs text-mineshaft-200">
          {mappingError}
        </div>
      )}
      <div className="mt-2 rounded-sm border border-yellow/40 bg-yellow/10 p-3 text-xs text-mineshaft-200">
        These keys will appear as normal secrets in your project but are tied to a sandboxed IAM
        user with zero permissions. Any API call made with these credentials triggers an alert.
      </div>
    </div>
  );
};
