// Plugin entry point — exports OpenClawPluginModule

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { qqChannelPlugin, setPluginRuntime } from "./channel.js";
import { createPollCreateTool, createPollResultTool } from "./poll.js";
import { createQQResolveImageTool } from "./resolve-image.js";
import { createQQResolveMemberTool } from "./resolve-member.js";
import { createQQDownloadFileTool } from "./download-file.js";

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

    // Register qq_resolve_image tool for retrieving historical images
    api.registerTool(createQQResolveImageTool, { name: "qq_resolve_image" });

    // Register qq_resolve_member tool for looking up group members by nickname
    api.registerTool(createQQResolveMemberTool, { name: "qq_resolve_member" });

    // Register qq_download_group_file tool for on-demand file downloads
    api.registerTool(createQQDownloadFileTool, { name: "qq_download_group_file" });
  },
};

export default plugin;
