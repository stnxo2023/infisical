import { useReducer } from "react";
import { Check, ClipboardCopy, EyeOff } from "lucide-react";

import {
  Field,
  FieldContent,
  FieldLabel,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@app/components/v3";
import { useTimedReset } from "@app/hooks";
import { TAwsHoneyToken } from "@app/hooks/api/honeyTokens/types";

type Props = {
  secretsMapping: TAwsHoneyToken["secretsMapping"];
  credentials: Record<string, string>;
};

const CREDENTIAL_FIELDS: { key: keyof TAwsHoneyToken["secretsMapping"]; label: string }[] = [
  { key: "accessKeyId", label: "Access Key ID" },
  { key: "secretAccessKey", label: "Secret Access Key" }
];

const CredentialField = ({ label, value }: { label: string; value?: string }) => {
  const [showCredential, toggleShowCredential] = useReducer((prev) => !prev, false);
  const [, isCopied, setCopied] = useTimedReset<string>({
    initialState: ""
  });

  if (!value) return null;

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <FieldContent>
        <div className="flex w-full min-w-0 items-center gap-1">
          <span
            className="min-w-0 flex-1 truncate font-mono text-sm"
            title={showCredential ? value : undefined}
          >
            {showCredential ? value : "****************************"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                variant="ghost"
                size="xs"
                onClick={() => {
                  setCopied(value);
                  navigator.clipboard.writeText(value);
                }}
                aria-label={`Copy ${label}`}
              >
                {isCopied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>Copy {label}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                variant="ghost"
                size="xs"
                onClick={toggleShowCredential}
                aria-label={`${showCredential ? "Hide" : "Show"} ${label}`}
              >
                <EyeOff className="size-3.5" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>
              {showCredential ? "Hide" : "Show"} {label}
            </TooltipContent>
          </Tooltip>
        </div>
      </FieldContent>
    </Field>
  );
};

export const AwsHoneyTokenCredentials = ({ secretsMapping, credentials }: Props) => {
  return (
    <div className="flex flex-col gap-4">
      {CREDENTIAL_FIELDS.map(({ key, label }) => {
        const secretName = secretsMapping[key];
        const value = secretName ? credentials[secretName] : undefined;

        return <CredentialField key={key} label={label} value={value} />;
      })}
    </div>
  );
};
