import { Heading, Section, Text } from "@react-email/components";
import React from "react";

import { BaseEmailWrapper, BaseEmailWrapperProps } from "./BaseEmailWrapper";
import { BaseLink } from "./BaseLink";

interface HoneyTokenTriggeredTemplateProps extends Omit<BaseEmailWrapperProps, "title" | "preview" | "children"> {
  honeyTokenName: string;
  projectName: string;
  eventName: string;
  eventTime: string;
  sourceIp: string;
  awsRegion: string;
  projectUrl: string;
}

export const HoneyTokenTriggeredTemplate = ({
  honeyTokenName,
  projectName,
  eventName,
  eventTime,
  sourceIp,
  awsRegion,
  projectUrl,
  siteUrl
}: HoneyTokenTriggeredTemplateProps) => {
  return (
    <BaseEmailWrapper
      title="Honey Token Triggered"
      preview={`Honey token "${honeyTokenName}" was triggered in project "${projectName}".`}
      siteUrl={siteUrl}
    >
      <Heading className="text-black text-[18px] leading-[28px] text-center font-normal p-0 mx-0">
        Honey token <strong>{honeyTokenName}</strong> was triggered in project{" "}
        <strong>{projectName}</strong>
      </Heading>
      <Section className="px-[24px] mt-[36px] pt-[24px] pb-[8px] border border-solid border-gray-200 rounded-md bg-gray-50">
        <strong className="text-[14px]">Event</strong>
        <Text className="text-[14px] mt-[4px]">{eventName}</Text>
        <strong className="text-[14px]">Time</strong>
        <Text className="text-[14px] mt-[4px]">{eventTime}</Text>
        <strong className="text-[14px]">Source IP</strong>
        <Text className="text-[14px] mt-[4px]">{sourceIp}</Text>
        <strong className="text-[14px]">AWS Region</strong>
        <Text className="text-[14px] mt-[4px]">{awsRegion}</Text>
        <Text className="text-[14px]">
          View the honey token details in{" "}
          <BaseLink href={projectUrl}>your project</BaseLink>.
        </Text>
      </Section>
    </BaseEmailWrapper>
  );
};

export default HoneyTokenTriggeredTemplate;

HoneyTokenTriggeredTemplate.PreviewProps = {
  honeyTokenName: "staging-honey-token",
  projectName: "My Project",
  eventName: "GetSecretValue",
  eventTime: "2026-04-28T12:00:00Z",
  sourceIp: "203.0.113.42",
  awsRegion: "us-east-1",
  projectUrl: "https://app.infisical.com/project/123",
  siteUrl: "https://infisical.com"
} as HoneyTokenTriggeredTemplateProps;
