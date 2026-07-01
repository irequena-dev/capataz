import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const BackendSchema = z.object({
  command: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).default({}),
  timeout_minutes: z.number().positive(),
});

const RolesSchema = z.strictObject({
  planner: z.string().optional(),
  armorer: z.string().optional(),
  executor: z.string(),
  reviewer: z.string().optional(),
  fixer_l2: z.string().optional(),
  fixer_l3: z.string().optional(),
  architect: z.string().optional(),
  security_auditor: z.string().optional(),
});

const ConfigSchema = z.object({
  backends: z.record(z.string(), BackendSchema),
  roles: RolesSchema,
  budgets: z.object({
    max_attempts_per_issue: z.number().int().positive(),
    max_escalations_per_run: z.number().int().positive(),
    max_audit_issues: z.number().int().nonnegative(),
  }),
});

export type Backend = z.infer<typeof BackendSchema>;
export type Role = keyof z.infer<typeof RolesSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadConfigOptions {
  globalConfigPath?: string;
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return Bun.YAML.parse(readFileSync(path, "utf8"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(base[key], value);
  }
  return merged;
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): Config {
  const globalConfigPath =
    options.globalConfigPath ?? join(homedir(), ".config", "capataz", "config.yaml");
  const projectConfigPath = join(cwd, "capataz.yaml");

  const globalRaw = readYaml(globalConfigPath);
  const projectRaw = readYaml(projectConfigPath);
  if (globalRaw === undefined && projectRaw === undefined) {
    throw new Error(
      `No config found: neither ${globalConfigPath} nor ${projectConfigPath} exists`,
    );
  }

  const merged = deepMerge(globalRaw ?? {}, projectRaw);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid config:\n  ${details}`);
  }

  const config = parsed.data;
  for (const [role, backend] of Object.entries(config.roles)) {
    if (!(backend in config.backends)) {
      throw new Error(
        `Invalid config:\n  roles.${role}: unknown backend "${backend}" (not declared in backends)`,
      );
    }
  }
  return config;
}
