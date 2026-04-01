说明：本文件用于记录本次 dynamicAgents 需求的原始 prompt，便于后续追溯和对照实现。

帮我订一个改动方案，我需要实现类似于上个目录 wecom 插件一样的 dynamicagents 功能，这应该是个配置可以 enable 来控制开关，开启后在新用户的会话产生时，需要创建一个对应的 agent 目录，以及对应的 workspace 文件夹（包括从源agent 中复制 skills， AGENTS.md 等文件，可参考 wecom），skills 的 watch 机制同样可参考 wecom，要求同样是不改 openclaw core，以及参照当前代码逻辑和风格做最小改动，代码职责和逻辑一定要清晰，可以加一些日志方便调试
