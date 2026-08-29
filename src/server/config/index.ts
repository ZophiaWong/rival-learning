import "server-only";

import {
  getProviderConfigurationStatus,
  parseServerConfig,
  type ServerConfig,
} from "./server-config";

let cachedConfig: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  cachedConfig ??= parseServerConfig(process.env);
  return cachedConfig;
}

export function getSafeProviderConfigurationStatus() {
  return getProviderConfigurationStatus(getServerConfig());
}
