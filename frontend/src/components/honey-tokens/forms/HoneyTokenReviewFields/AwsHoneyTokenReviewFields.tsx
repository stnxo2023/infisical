import { useFormContext } from "react-hook-form";

import { GenericFieldLabel } from "@app/components/v2";
import { HoneyTokenType } from "@app/hooks/api/honeyTokens/enums";

import { THoneyTokenForm } from "../schemas";
import { HoneyTokenReviewSection } from "./HoneyTokenReviewSection";

export const AwsHoneyTokenReviewFields = () => {
  const { watch } = useFormContext<THoneyTokenForm & { type: HoneyTokenType.AWS }>();

  const { accessKeyId, secretAccessKey } = watch("secretsMapping");

  return (
    <HoneyTokenReviewSection label="Secret Mapping">
      <GenericFieldLabel label="Access Key ID">{accessKeyId}</GenericFieldLabel>
      <GenericFieldLabel label="Secret Access Key">{secretAccessKey}</GenericFieldLabel>
    </HoneyTokenReviewSection>
  );
};
