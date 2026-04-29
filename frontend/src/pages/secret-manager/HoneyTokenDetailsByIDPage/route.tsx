import { createFileRoute, linkOptions } from "@tanstack/react-router";

import { HoneyTokenDetailsByIDPage } from "./HoneyTokenDetailsByIDPage";

export const Route = createFileRoute(
  "/_authenticate/_inject-org-details/_org-layout/organizations/$orgId/projects/secret-management/$projectId/_secret-manager-layout/honey-tokens/$honeyTokenId"
)({
  component: HoneyTokenDetailsByIDPage,
  beforeLoad: ({ context, params }) => {
    return {
      breadcrumbs: [
        ...context.breadcrumbs,
        {
          label: "Overview",
          link: linkOptions({
            to: "/organizations/$orgId/projects/secret-management/$projectId/overview",
            params
          })
        },
        {
          label: "Honey Token"
        }
      ]
    };
  }
});
