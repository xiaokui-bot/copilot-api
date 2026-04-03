# copilot-api GPT-5 限制功能说明

## 功能概述

在 copilot-api 中转服务中添加了 GPT-5 系列模型的使用限制开关。默认情况下**关闭**GPT-5 模型访问，需要显式启用才能使用。

## 配置方式

### 启动时启用 GPT-5

```bash
copilot-api start --allow-gpt5
```

或使用 bun 运行源码：
```bash
bun run src/start.ts --allow-gpt5
```

### 默认行为（不添加参数）

```bash
copilot-api start
# allowGpt5 默认为 false，GPT-5 模型不可用
```

## 限制范围

当 `--allow-gpt5` 未启用时，以下 GPT-5 系列模型将被阻止：
- `gpt-5`
- `gpt-5-chat-latest`
- `gpt-5-codex`
- `gpt-5-mini`
- `gpt-5-mini-2025-08-07`
- `gpt-5-nano`
- `gpt-5-nano-2025-08-07`
- `gpt-5-pro`
- `gpt-5-pro-2025-10-06`
- 以及任何以 `gpt-5` 开头的模型

## 错误响应

当用户尝试使用 GPT-5 模型但未启用时，返回 403 错误：

```json
{
  "error": {
    "message": "GPT-5 series models are disabled. Enable them with --allow-gpt5 flag.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_allowed"
  }
}
```

## 修改文件

1. `src/lib/state.ts` - 添加 `allowGpt5` 状态字段
2. `src/start.ts` - 添加 `--allow-gpt5` 命令行参数
3. `src/routes/chat-completions/handler.ts` - OpenAI 接口检查
4. `src/routes/messages/handler.ts` - Anthropic 接口检查

## 构建部署

```bash
cd ~/Projects/copilot-api
bun install
bun run build
cp dist/main.js /usr/local/lib/node_modules/copilot-api/dist/main.js
```

## 使用示例

### 禁用 GPT-5（默认）
```bash
copilot-api start
# 或
copilot-api start --allow-gpt5=false
```

### 启用 GPT-5
```bash
copilot-api start --allow-gpt5
# 或
copilot-api start --allow-gpt5=true
```
