import { routeAgentRequest } from "agents";

export { TeamAgent } from "./team-agent";
export { SwapWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
