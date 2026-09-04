const TEST_ROLE_RUNNER_SWITCH = "RIVAL_TEST_SCRIPTED_ROLE_RUNNER";

export function scriptedRoleRunnerEnabled(
  environment: Record<string, string | undefined>,
): boolean {
  const enabled = environment[TEST_ROLE_RUNNER_SWITCH] === "1";
  if (enabled && environment.NODE_ENV === "production") {
    throw new Error(`${TEST_ROLE_RUNNER_SWITCH} is forbidden in production`);
  }
  return enabled;
}
