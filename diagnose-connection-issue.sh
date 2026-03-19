#!/bin/bash

echo "=========================================="
echo "DingTalk Connector 连接问题诊断脚本"
echo "=========================================="
echo ""

echo "1. 环境信息"
echo "----------------------------------------"
echo "Node.js 版本:"
node --version
echo ""
echo "npm 版本:"
npm --version
echo ""
echo "操作系统:"
uname -a
echo ""
echo "网络代理:"
echo "HTTP_PROXY: ${HTTP_PROXY:-未设置}"
echo "HTTPS_PROXY: ${HTTPS_PROXY:-未设置}"
echo ""

echo "2. 插件安装信息"
echo "----------------------------------------"
echo "插件列表:"
openclaw plugins list | grep -i dingtalk
echo ""

echo "3. 插件目录检查"
echo "----------------------------------------"
PLUGIN_DIR="$HOME/.openclaw/extensions/dingtalk-connector-0.8.0"
if [ -d "$PLUGIN_DIR" ]; then
    echo "插件目录存在: $PLUGIN_DIR"
    echo ""
    echo "Git 版本:"
    cd "$PLUGIN_DIR" && git log --oneline -1
    echo ""
    echo "Git 状态:"
    cd "$PLUGIN_DIR" && git status --short
    echo ""
    echo "依赖检查:"
    if [ -d "$PLUGIN_DIR/node_modules/dingtalk-stream" ]; then
        echo "✅ dingtalk-stream 已安装"
        echo "版本: $(cd $PLUGIN_DIR && npm list dingtalk-stream 2>/dev/null | grep dingtalk-stream)"
    else
        echo "❌ dingtalk-stream 未安装"
    fi
else
    echo "❌ 插件目录不存在: $PLUGIN_DIR"
fi
echo ""

echo "4. 配置检查"
echo "----------------------------------------"
echo "DingTalk 配置:"
openclaw config get channels.dingtalk-connector 2>&1 | grep -v "clientSecret"
echo ""

echo "5. Gateway 日志（最近 50 行）"
echo "----------------------------------------"
openclaw gateway logs -n 50 2>&1 | tail -50
echo ""

echo "=========================================="
echo "诊断完成！"
echo "=========================================="
echo ""
echo "请将以上完整输出发送给开发者进行分析。"
echo ""
echo "特别关注："
echo "- 是否有 'Starting DingTalk Stream client...' 日志"
echo "- 是否有 'Connected to DingTalk Stream successfully' 日志"
echo "- 是否有任何错误信息"
echo "- dingtalk-stream 依赖是否正确安装"
