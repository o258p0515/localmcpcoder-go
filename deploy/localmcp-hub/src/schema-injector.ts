export function injectRunnerArguments(tools: any[]): any[] {
  return tools.map((tool) => {
    const copy = structuredClone(tool);
    const schema = copy.inputSchema ?? copy.input_schema;
    if (!schema || schema.type !== "object") return copy;
    schema.properties ??= {};
    schema.properties.runner_id = {
      type: "string",
      description: "Optional runner ID for this call; overrides the session-selected runner."
    };
    schema.properties.async = {
      type: "boolean",
      description: "Return a job_id immediately and retrieve completion with get_job_result."
    };
    return copy;
  });
}

export function stripRunnerArguments(args: Record<string, unknown>): { args: Record<string, unknown>; runnerId?: string; async: boolean } {
  const clean = { ...args };
  const runnerId = typeof clean.runner_id === "string" && clean.runner_id ? clean.runner_id : undefined;
  const async = clean.async === true;
  delete clean.runner_id;
  delete clean.async;
  return { args: clean, runnerId, async };
}
