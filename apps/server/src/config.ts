export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
