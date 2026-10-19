# Pi on Cloudflare Agents

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/irvinebroque/pi-on-cloudflare)

A minimal example of running [Pi](https://pi.dev/docs/latest/sdk) on Cloudflare with the [Agents SDK](https://developers.cloudflare.com/agents/).

This repo is intentionally small. It shows the basic shape, not a full coding environment.

Live demo: [pi-on-cloudflare-code.roundtrip.workers.dev](https://pi-on-cloudflare-code.roundtrip.workers.dev)

## What This Shows

- A static chat UI served by Workers Static Assets.
- A Worker API with `/api/status` and `/api/prompt`.
- One `PiAgent` Durable Object, created with the Agents SDK `Agent` class.
- Pi's core agent loop running inside that Durable Object.
- Model calls through the Cloudflare AI Gateway binding, with no provider API keys in Worker code.
- Durable execution with `runFiber()`, `stash()`, and `onFiberRecovered()`.
- Untrusted JavaScript execution in isolated Dynamic Workers via a Pi tool.

## Request Flow

```text
Browser
  -> /api/prompt
  -> PiAgent Durable Object
  -> runFiber("pi-prompt")
  -> Pi core agent
  -> execute_js tool when code is useful
  -> Dynamic Worker sandbox
  -> env.AI.run(... AI Gateway ...)
```

## Getting Started

Install dependencies:

```sh
npm install
```

Run locally:

```sh
npm run dev
```

Deploy:

```sh
npm run deploy
```

The deployed Worker serves the UI at `/`.

The Deploy to Cloudflare button provisions the Worker, the Durable Object class, the AI binding, and static assets from `wrangler.jsonc`.

## Configuration

The important bindings and settings live in `wrangler.jsonc`:

```jsonc
{
  "ai": { "binding": "AI" },
  "vars": {
    "PI_MODEL": "openai/gpt-4.1-mini",
    "AI_GATEWAY_ID": "default"
  },
  "durable_objects": {
    "bindings": [{ "name": "PiAgent", "class_name": "PiAgent" }]
  },
  "worker_loaders": [{ "binding": "LOADER" }],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PiAgent"] }]
}
```

The `AI` binding calls models through AI Gateway. Third-party models use Cloudflare's AI Gateway / unified billing path, so this example does not read `OPENAI_API_KEY` or other provider secrets from the Worker.

## Durable Execution

Each turn runs inside an Agents SDK fiber:

```ts
return await this.runFiber("pi-prompt", async (fiber) => {
  fiber.stash({ prompt });
  const result = await this.completeTurn(prompt);
  this.setState({ requests: this.state.requests + 1 });
  return result;
});
```

If the Durable Object is evicted while the turn is running, the original HTTP request cannot be resumed. The recovery hook defines the fallback behavior: replay the stashed prompt and persist recovery evidence in Agent state.

## Code Execution

The agent has one tool, `execute_js`, that runs generated JavaScript in an isolated Dynamic Worker. Network access is blocked for the sandbox; generated code can only return a result, errors, and captured logs.

## Draft Agents Docs

This repo also includes a draft page for the Cloudflare Agents docs Harnesses section:

- [`docs/agents-harnesses-pi.md`](./docs/agents-harnesses-pi.md)

## Status

**PARKED 2026-10-19 (Perk).** Blocked since 2026-09-13 on AI Gateway credits; Worker returned 404 on 2026-10-02. No active work planned.
