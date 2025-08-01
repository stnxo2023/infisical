import { Heading, Section, Text } from "@react-email/components";
import React from "react";

import { BaseButton } from "./BaseButton";
import { BaseEmailWrapper, BaseEmailWrapperProps } from "./BaseEmailWrapper";
import { BaseLink } from "./BaseLink";

interface AccessApprovalRequestTemplateProps extends Omit<BaseEmailWrapperProps, "title" | "preview" | "children"> {
  projectName: string;
  requesterFullName: string;
  requesterEmail: string;
  isTemporary: boolean;
  secretPath: string;
  environment: string;
  expiresIn: string;
  permissions: string[];
  note?: string;
  approvalUrl: string;
}

export const AccessApprovalRequestTemplate = ({
  projectName,
  siteUrl,
  requesterFullName,
  requesterEmail,
  isTemporary,
  secretPath,
  environment,
  expiresIn,
  permissions,
  note,
  approvalUrl
}: AccessApprovalRequestTemplateProps) => {
  return (
    <BaseEmailWrapper
      title="Access Approval Request"
      preview="A new access approval request is pending your review."
      siteUrl={siteUrl}
    >
      <Heading className="text-black text-[18px] leading-[28px] text-center font-normal p-0 mx-0">
        You have a new access approval request pending review for the project <strong>{projectName}</strong>
      </Heading>
      <Section className="px-[24px] mb-[28px] mt-[36px] pt-[12px] pb-[8px] border border-solid border-gray-200 rounded-md bg-gray-50">
        <Text className="text-black text-[14px] leading-[24px]">
          <strong>{requesterFullName}</strong> (<BaseLink href={`mailto:${requesterEmail}`}>{requesterEmail}</BaseLink>)
          has requested {isTemporary ? "temporary" : "permanent"} access to <strong>{secretPath}</strong> in the{" "}
          <strong>{environment}</strong> environment.
        </Text>

        {isTemporary && (
          <Text className="text-[14px] text-red-600 leading-[24px]">
            <strong>This access will expire {expiresIn} after approval.</strong>
          </Text>
        )}
        <Text className="text-[14px] leading-[24px] mb-[4px]">
          <strong>The following permissions are requested:</strong>
        </Text>
        {permissions.map((permission) => (
          <Text key={permission} className="text-[14px] my-[2px] leading-[24px]">
            - {permission}
          </Text>
        ))}
        {note && (
          <Text className="text-[14px] text-slate-700 leading-[24px]">
            <strong className="text-black">User Note:</strong> "{note}"
          </Text>
        )}
      </Section>
      <Section className="text-center">
        <BaseButton href={approvalUrl}>Review Request</BaseButton>
      </Section>
    </BaseEmailWrapper>
  );
};

export default AccessApprovalRequestTemplate;

AccessApprovalRequestTemplate.PreviewProps = {
  requesterFullName: "Abigail Williams",
  requesterEmail: "abigail@infisical.com",
  isTemporary: true,
  secretPath: "/api/secrets",
  environment: "Production",
  siteUrl: "https://infisical.com",
  projectName: "Example Project",
  expiresIn: "1 day",
  permissions: ["Read Secret", "Delete Project", "Create Dynamic Secret"],
  note: "I need access to these permissions for the new initiative for HR."
} as AccessApprovalRequestTemplateProps;
