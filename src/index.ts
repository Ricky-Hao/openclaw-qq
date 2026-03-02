// Plugin entry point — exports OpenClawPluginModule

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { qqChannelPlugin, setPluginRuntime } from "./channel.js";
import { createPollCreateTool, createPollResultTool } from "./poll.js";

const plugin = {
  id: "openclaw-qq",
  name: "QQ Channel",
  description: "QQ messaging via OneBot v11 (NapCat)",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    // Capture the full PluginRuntime for use in gateway/outbound adapters.
    // ChannelGatewayContext only provides RuntimeEnv (log/error/exit),
    // but we need the full runtime for resolveAgentRoute, finalizeInboundContext,
    // dispatchReplyWithBufferedBlockDispatcher, etc.
    setPluginRuntime(api.runtime);

    api.registerChannel(qqChannelPlugin);

    // Register poll tools (context-aware — created per agent session)
    api.registerTool(createPollCreateTool, { name: "poll_create" });
    api.registerTool(createPollResultTool, { name: "poll_result" });
  },
};

export default plugin;
