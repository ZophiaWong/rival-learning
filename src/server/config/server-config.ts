import { z } from "zod";

const roleNames = ["interviewer", "candidate", "judge"] as const;

type RoleName = (typeof roleNames)[number];

const environmentSchema = z.object({
  RIVAL_DATABASE_PATH: z.string().trim().min(1),
  RIVAL_HOST: z.literal("127.0.0.1"),
  RIVAL_INTERVIEWER_PROVIDER: z.string().trim().optional(),
  RIVAL_INTERVIEWER_MODEL: z.string().trim().optional(),
  RIVAL_INTERVIEWER_API_KEY: z.string().trim().optional(),
  RIVAL_CANDIDATE_PROVIDER: z.string().trim().optional(),
  RIVAL_CANDIDATE_MODEL: z.string().trim().optional(),
  RIVAL_CANDIDATE_API_KEY: z.string().trim().optional(),
  RIVAL_JUDGE_PROVIDER: z.string().trim().optional(),
  RIVAL_JUDGE_MODEL: z.string().trim().optional(),
  RIVAL_JUDGE_API_KEY: z.string().trim().optional(),
});

export interface RoleProviderConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
}

export interface ServerConfig {
  databasePath: string;
  host: "127.0.0.1";
  providers: Record<RoleName, RoleProviderConfig>;
}

export interface ProviderConfigurationStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
}

export class ServerConfigError extends Error {
  readonly code = "invalid_server_configuration";

  constructor(fields: string[]) {
    super(`Invalid server configuration: ${fields.join(", ")}`);
    this.name = "ServerConfigError";
  }
}

export function parseServerConfig(
  environment: Record<string, string | undefined>,
): ServerConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))]
      .filter(Boolean)
      .sort();
    throw new ServerConfigError(fields);
  }

  return {
    databasePath: result.data.RIVAL_DATABASE_PATH,
    host: result.data.RIVAL_HOST,
    providers: {
      interviewer: {
        provider: result.data.RIVAL_INTERVIEWER_PROVIDER,
        model: result.data.RIVAL_INTERVIEWER_MODEL,
        apiKey: result.data.RIVAL_INTERVIEWER_API_KEY,
      },
      candidate: {
        provider: result.data.RIVAL_CANDIDATE_PROVIDER,
        model: result.data.RIVAL_CANDIDATE_MODEL,
        apiKey: result.data.RIVAL_CANDIDATE_API_KEY,
      },
      judge: {
        provider: result.data.RIVAL_JUDGE_PROVIDER,
        model: result.data.RIVAL_JUDGE_MODEL,
        apiKey: result.data.RIVAL_JUDGE_API_KEY,
      },
    },
  };
}

export function getProviderConfigurationStatus(
  config: ServerConfig,
): Record<RoleName, ProviderConfigurationStatus> {
  return Object.fromEntries(
    roleNames.map((role) => {
      const providerConfig = config.providers[role];
      return [
        role,
        {
          configured: Boolean(
            providerConfig.provider && providerConfig.model && providerConfig.apiKey,
          ),
          provider: providerConfig.provider ?? null,
          model: providerConfig.model ?? null,
        },
      ];
    }),
  ) as Record<RoleName, ProviderConfigurationStatus>;
}
