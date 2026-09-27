import { appendModuleConfigArrayString } from "./edits.ts";
import type { Rule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { finding, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";
import { useToken } from "./useToken.ts";

const RULE_ID = "authz/media-list";
const DEFAULT_LIST_PERMISSION = "media.list";

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function listPermissionOf(config: unknown): string {
  if (typeof config !== "object" || config === null || !("listPermission" in config)) return DEFAULT_LIST_PERMISSION;
  return typeof config.listPermission === "string" ? config.listPermission : DEFAULT_LIST_PERMISSION;
}

function covers(granted: readonly string[], permission: string): boolean {
  const dot = permission.indexOf(".");
  return granted.includes("*") || granted.includes(permission) || (dot !== -1 && granted.includes(`${permission.slice(0, dot)}.*`));
}

/** With media-default and authz-roles, a role written in the config that grants `media.read` also needs the listing permission, which media listing now checks. */
export const mediaListRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const media = moduleEntry(ctx, "media-default");
    const written = ctx.project.input.config.modules.find((m) => useToken(m.use) === "authz-roles");
    if (media === undefined || written === undefined) return [];
    const roles: unknown = typeof written.config === "object" && written.config !== null && "roles" in written.config ? written.config.roles : undefined;
    if (typeof roles !== "object" || roles === null) return [];
    const permission = listPermissionOf(media.config);
    const source = ctx.readFile(ctx.project.configFile);
    const findings: Finding[] = [];
    for (const [role, granted] of Object.entries(roles)) {
      if (!stringArray(granted) || !granted.includes("media.read") || covers(granted, permission)) continue;
      const edits: Edit[] = [];
      const edit = source === undefined ? undefined : appendModuleConfigArrayString(ctx.project.configFile, source, { use: written.use, path: ["roles", role], value: permission });
      if (edit) edits.push(edit);
      findings.push(
        finding(
          `${RULE_ID}:${role}`,
          RULE_ID,
          `role "${role}" grants media.read but not ${permission}; media-default now requires ${permission} to list media, so this role can no longer open the media library`,
          `add "${permission}" to the role's permissions in authz-roles' config`,
          { file: ctx.project.configFile },
          edits,
          upgradingDocs("authz-media-list"),
          "warning",
        ),
      );
    }
    return findings;
  },
};
