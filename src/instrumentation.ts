export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerConfig } = await import("@/server/config");
    getServerConfig();
  }
}
