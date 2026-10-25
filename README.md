# llm-agent

An agent loop in TypeScript with filesystem tools, web search and web fetch. It works with local models (llama.cpp, Ollama, LM Studio, vLLM), OpenAI, Anthropic, or any OpenAI-compatible endpoint, and you can drive it from a terminal or from a browser UI.

Node runs the TypeScript directly (≥ 22.18, no build step), or you can run the whole stack in Docker.

## Quick start

**Docker (everything included):**

```bash
cp .env.example .env              # optional: API keys, LLM URL
docker compose up -d --build      # agent UI + SearXNG search
open http://127.0.0.1:8787
```

**Local Node:**

```bash
npm install
cp .env.example .env
npm run search:up                 # SearXNG in Docker (optional but recommended)
npm run playground                # UI on http://127.0.0.1:8787, workspace ./playground
npm start                         # terminal chat in the current directory
node src/cli.ts -w ./playground "Summarise every markdown file into SUMMARY.md"
```

Click **⚙ Config** (or the model name) in the UI to choose a provider and model. The choice is saved and reused by the CLI too.

## Providers and models

| Provider | How it connects | Key |
|---|---|---|
| **Local** | OpenAI-compatible `/v1` (default `http://localhost:9931/v1`, or `LLM_BASE_URL`) | optional |
| **OpenAI** | `https://api.openai.com/v1`, chat models only in the list | `OPENAI_API_KEY` or typed in the UI |
| **Anthropic** | Native Messages API via `@anthropic-ai/sdk`, with a streaming adapter | `ANTHROPIC_API_KEY` or typed in the UI |
| **Custom** | Any OpenAI-compatible URL (OpenRouter, Groq, Together, a remote Ollama…) | optional |

**Scan models** lists what the provider offers. For Anthropic it also fills in each model's context window.

Settings are stored in `~/.llm-agent/settings.json` (mode 0600, override with `AGENT_CONFIG_DIR`; in Docker, the `agent-config` volume). They are never stored in the repository. Keys from `.env` are used but not copied into that file, and the browser only ever sees a `••••last4` hint.

Precedence: CLI flags (`-m`, `-u`, `-k`) > settings saved in the UI > `.env` / defaults.

Switching provider mid-conversation keeps the conversation. The transcript is stored in one format, and each adapter translates it per request.

## How it works

```
user message
   └─► model (streamed) ──► text?  ───────────────► done (RunResult)
              │
              └─► tool calls ─► validate ─► policy ─► approve? ─► run ─► results ─┐
                     ▲                                                              │
                     └──────────────────────────────────────────────────────────────┘
```

### Contracts

| Contract | Where | Guarantees |
|---|---|---|
| `ChatClient` | [src/providers.ts](src/providers.ts) | `streamChat()` takes OpenAI-shaped requests and returns OpenAI-shaped chunks. `listModels()` returns `{ id, label?, contextTokens? }`. The Anthropic adapter maps system/tool_use/tool_result, keeps roles alternating, and sanitises tool ids. |
| `Tool` | [src/tools/types.ts](src/tools/types.ts) | snake_case name, JSON-Schema `parameters`, a `risk` (`read` / `write` / `destructive`). Side-effecting tools implement `describe()`, which validates and previews without changing anything. Recoverable failures are thrown as `ToolError`. |
| `Agent.run()` | [src/agent.ts](src/agent.ts) | Returns a `RunResult` `{ text, stopReason, steps, toolCalls, usage }`. It never throws for tool errors, bad arguments, denials or cancellation. The transcript always stays valid to resend. |
| `PermissionPolicy` | | `read-only`, `ask`, `auto-edit` (writes run, deletes ask), `auto`, plus `allow` / `deny` tool lists |

### Rules the harness enforces in code

1. Arguments are parsed leniently, coerced (`"5"` → `5`), and validated against the schema. Errors go back to the model so it can fix them.
2. No write or destructive tool runs unless the policy allows it. In `ask` mode the human sees a summary and preview first.
3. Filesystem tools are confined to the workspace, including symlink escapes.
4. `web_fetch` refuses localhost and private IPs, checked on every redirect (`AGENT_ALLOW_PRIVATE_FETCH=1` lifts this).
5. The same call repeated more than 3 times is blocked as a loop. There's a per-tool timeout, a result-size cap, and a step limit.
6. Context management: the agent learns chars-per-token from usage reports, shrinks old tool output, drops old turns, and retries after an overflow error.
7. Web and file content is treated as data, never instructions. `AGENTS.md` in the workspace is added as project rules.

### Tools

| Tool | Risk | |
|---|---|---|
| `list_dir`, `read_file`, `find_files`, `search_files` | read | explore files; line-numbered reads with ranges, glob, grep |
| `write_file`, `edit_file`, `make_dir`, `move_path` | write | `edit_file` needs an exact, unique snippet |
| `delete_path` | destructive | asks unless the mode is `auto` |
| `web_search` | read | Tavily → Brave → SearXNG → DuckDuckGo, whichever is configured first |
| `web_fetch` | read | HTML → readable Markdown, JSON pretty-printed, paginated |

**Search:** `npm run search:up` starts SearXNG on `127.0.0.1:8888` (config in [searxng/settings.yml](searxng/settings.yml)), and `.env.example` already points `SEARXNG_URL` at it. Keyless DuckDuckGo often answers scripts with a bot challenge, so prefer SearXNG or a Brave or Tavily key.

## Docker

[docker-compose.yml](docker-compose.yml) runs two services:

- **agent**: built from the [Dockerfile](Dockerfile) (`node:24-alpine`, runs as a non-root user, has a healthcheck). Published on `127.0.0.1:${AGENT_PORT:-8787}`. Your workspace is mounted at `/workspace` (`AGENT_WORKSPACE`, default `./playground`). Settings live in the `agent-config` volume.
- **searxng**: pinned image, published on `127.0.0.1:8888`, reached by the agent as `http://searxng:8080`.

The LLM stays outside the stack. Inside the container `localhost` is the container itself, so the agent reaches your host's model server via `http://host.docker.internal:9931/v1` (override with `DOCKER_LLM_BASE_URL`). OpenAI and Anthropic need nothing extra.

```bash
npm run docker:up        # build + start
npm run docker:logs
npm run docker:down
AGENT_WORKSPACE=~/code/my-project AGENT_PORT=8800 docker compose up -d
```

On Linux, the container user (uid 1000) needs write access to the mounted workspace.

## Rich answers

Answers are rendered as Markdown with:

- **Math**: KaTeX, for `$…$`, `\(…\)` (inline) and `$$…$$`, `\[…\]` (display, also mid-sentence). Math is tokenised before Markdown, so `\\`, `_` and `*` inside formulas survive. Currency like `$5 and $10` stays plain text.
- **Diagrams**: ```` ```mermaid ```` blocks render as SVG in the HUD colours (flowcharts, sequence, pie, git, …), with a Source toggle. Mermaid loads only when the first diagram appears and runs in its `strict` security mode. Syntax errors show the message and the source.
- **Images**: rendered once the answer has finished streaming. **⚙ Config → Display** sets remote images to *Auto-load* (default), *Click to load*, or *Off*. The setting can't be bypassed:
  - The page's CSP allows only same-origin images, so the browser blocks every other way model output could load one: `srcset`, CSS `url()`, SVG `<image>`, video posters.
  - Allowed images come through `/api/image`. This proxy uses `web_fetch`'s guards (public addresses only, pinned DNS, checked redirects), accepts raster formats only up to 15 MB, and requires a per-server token that only the page knows.
  - The image host sees the server, not your browser. Fetching an image still sends its URL out, though, so a page the agent read could try to leak data through one. *Click to load* shows the host first.

KaTeX and Mermaid are served from `node_modules`, so this works offline and in Docker.

## Browser UI security

- The server binds to `127.0.0.1` by default (`HOST=0.0.0.0` only inside the container).
- API calls must carry this server's Host and Origin and a JSON body, so other sites in your browser can't drive the agent, and DNS rebinding is blocked. To expose it on a LAN name, add it to `AGENT_ALLOWED_HOSTS` (there is no login, so only do this on a trusted network).
- Model output is rendered through DOMPurify, under a strict Content-Security-Policy.

## Library use

```ts
import { Agent, createChatClient, fsTools, webTools } from "./src/index.ts";

const agent = new Agent({
  client: createChatClient({ kind: "anthropic" }),   // or "openai", "local", { kind: "custom", baseURL }
  model: "claude-sonnet-5-5",
  workspace: "./playground",
  tools: [...fsTools, ...webTools],
  permissions: { mode: "auto-edit" },
  approve: async ({ action }) => confirm(action.summary),
  events: { onText: (d) => process.stdout.write(d) },
});

const result = await agent.run("Find the latest Node.js LTS and write it to node.md");
console.log(result.stopReason, result.toolCalls.length);
```

A plain `new OpenAI({ baseURL, apiKey })` client is accepted too. Adding a tool means implementing `Tool`.

## Development

```bash
npm test             # 33 tests, no model or network needed
npm run typecheck
```

[test/harness.ts](test/harness.ts) is a scripted, OpenAI-compatible mock server. It streams SSE the way llama.cpp does, including split tool-call arguments, and provides `assertValidTranscript`. [test/providers.test.ts](test/providers.test.ts) runs the real agent loop against a mock Anthropic event stream. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests on Node 22 and 24, then builds and smoke-tests the Docker image.

## License

[MIT](LICENSE)
