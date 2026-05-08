/* eslint-disable no-await-in-loop */
import { packRules, unpackRules } from "@casl/ability/extra";
import { Knex } from "knex";

import { TableName } from "../schemas";

const PROJECT_SUBJECT = "project";
const REQUEST_ACCESS_ACTION = "request-access";

const CHUNK_SIZE = 1000;

export async function up(knex: Knex): Promise<void> {
  // Org-level custom roles are rows in `roles` where projectId IS NULL.
  // Built-in slugs (admin/member/no-access) are handled in code and not stored here.
  const customRoles = await knex(TableName.Role).whereNull("projectId").select("*");

  const toUpdate = customRoles
    .map((role) => {
      const rules = unpackRules((role.permissions ?? []) as Parameters<typeof unpackRules>[0]) as {
        action: string | string[];
        subject: string;
        inverted?: boolean;
      }[];

      // Skip if request-access on project is already present
      const alreadyHasPermission = rules.some(
        (rule) =>
          !rule.inverted &&
          rule.subject === PROJECT_SUBJECT &&
          (rule.action === REQUEST_ACCESS_ACTION ||
            (Array.isArray(rule.action) && rule.action.includes(REQUEST_ACCESS_ACTION)))
      );

      if (alreadyHasPermission) return null;

      const updatedRules = [...rules, { action: REQUEST_ACCESS_ACTION, subject: PROJECT_SUBJECT }];

      return {
        ...role,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-error packRules type mismatch
        permissions: JSON.stringify(packRules(updatedRules))
      };
    })
    .filter(Boolean) as typeof customRoles;

  for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
    await knex(TableName.Role).insert(chunk).onConflict("id").merge();
  }
}

export async function down(knex: Knex): Promise<void> {
  const customRoles = await knex(TableName.Role).whereNull("projectId").select("*");

  const toUpdate = customRoles
    .map((role) => {
      const rules = unpackRules((role.permissions ?? []) as Parameters<typeof unpackRules>[0]) as {
        action: string | string[];
        subject: string;
        inverted?: boolean;
      }[];

      let wasModified = false;
      const filteredRules = rules.filter((rule) => {
        if (rule.subject !== PROJECT_SUBJECT || rule.inverted) return true;
        if (rule.action === REQUEST_ACCESS_ACTION) {
          wasModified = true;
          return false;
        }
        if (Array.isArray(rule.action)) {
          const withoutRequestAccess = rule.action.filter((a) => a !== REQUEST_ACCESS_ACTION);
          if (withoutRequestAccess.length === 0) {
            wasModified = true;
            return false;
          }
          if (withoutRequestAccess.length !== rule.action.length) {
            wasModified = true;
          }
          // mutate in place to drop the action from the array
          // eslint-disable-next-line no-param-reassign
          rule.action = withoutRequestAccess;
        }
        return true;
      });

      if (!wasModified) return null;

      return {
        ...role,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-error packRules type mismatch
        permissions: JSON.stringify(packRules(filteredRules))
      };
    })
    .filter(Boolean) as typeof customRoles;

  for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
    await knex(TableName.Role).insert(chunk).onConflict("id").merge();
  }
}
