import { Agent, getAgentByName, type FiberRecoveryContext } from "agents";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { Agent as Pi, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	Type,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	gatewayRequestBody,
	isReasoningEffort,
	type ReasoningEffort,
} from "./gateway-request";

type State = {
	requests: number;
	codeExecutions?: number;
	recoveries?: number;
	lastRecoveredAnswer?: string;
};

const SYSTEM_PROMPT = "You are a concise assistant running inside a Cloudflare Durable Object.";

function reasoningEffortFromEnv(env: Env): ReasoningEffort {
	const value = env.PI_REASONING_EFFORT;
	if (!isReasoningEffort(value)) {
		throw new Error(`Invalid PI_REASONING_EFFORT: ${value}`);
	}
	return value;
}

function thinkingLevelFromEffort(effort: ReasoningEffort): ModelThinkingLevel {
	switch (effort) {
		case "none":
			return "off";
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return effort;
		case "max":
			return "xhigh";
		default: {
			const exhaustive: never = effort;
			throw new Error(`Unhandled reasoning effort: ${exhaustive}`);
		}
	}
}

function modelFromGatewayName(name: string, reasoningEffort: ReasoningEffort): Model<"openai-responses"> {
	const [provider, ...id] = name.split("/");

	return {
		id: id.join("/"),
		name,
		provider,
		api: "openai-responses",
		baseUrl: "",
		reasoning: reasoningEffort !== "none",
		input: ["text"],
		contextWindow: 1_050_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function outputText(output: unknown): string {
	const data = output as Record<string, unknown>;
	const choice = Array.isArray(data?.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
	const message = choice?.message as Record<string, unknown> | undefined;
	const fromResponses = Array.isArray(data?.output)
		? (data.output as Array<Record<string, unknown>>)
				.flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
				.filter((part) => part.type === "output_text" || part.type === "text")
				.map((part) => String(part.text ?? ""))
				.join("\n")
		: "";
	const candidates = [data?.response, data?.output_text, fromResponses, data?.content, message?.content, choice?.text];
	return String(candidates.find((value) => typeof value === "string" && value.length > 0) ?? "");
}

function gatewayToolCalls(output: unknown): Array<Record<string, unknown>> | undefined {
	const data = output as Record<string, unknown>;
	const choice = Array.isArray(data?.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
	const message = choice?.message as Record<string, unknown> | undefined;
	const chatCalls = message?.tool_calls;
	if (Array.isArray(chatCalls) && chatCalls.length > 0) return chatCalls as Array<Record<string, unknown>>;

	const responseCalls = Array.isArray(data?.output)
		? (data.output as Array<Record<string, unknown>>).filter((item) => item.type === "function_call")
		: [];
	return responseCalls.length > 0 ? responseCalls : undefined;
}

function assistant(model: Model<"openai-responses">, content: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: content ? [{ type: "text", text: content }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

function toolCallAssistant(model: Model<"openai-responses">, calls: Array<Record<string, unknown>>): AssistantMessage {
	return {
		...assistant(model, "", "toolUse"),
		content: calls.map((call, index) => {
			const fn = call.function as Record<string, unknown> | undefined;
			return {
				type: "toolCall" as const,
				id: String(call.call_id ?? call.id ?? `call_${index}`),
				name: String(fn?.name ?? call.name ?? ""),
				arguments: JSON.parse(String(fn?.arguments ?? call.arguments ?? "{}")),
			};
		}),
	};
}

function streamFromGateway(env: Env, model: Model<"openai-responses">, context: Context) {
	const stream = createAssistantMessageEventStream();
	const reasoningEffort = reasoningEffortFromEnv(env);

	void (async () => {
		try {
			stream.push({ type: "start", partial: assistant(model, "") });
			const output = await env.AI.run(
				model.name,
				{ ...gatewayRequestBody(context, reasoningEffort) },
				{ gateway: { id: env.AI_GATEWAY_ID, collectLog: true } },
			);
			const toolCalls = gatewayToolCalls(output);
			if (toolCalls) {
				stream.push({ type: "done", reason: "toolUse", message: toolCallAssistant(model, toolCalls) });
				return;
			}

			const answer = outputText(output);
			const done = assistant(model, answer);

			stream.push({ type: "text_start", contentIndex: 0, partial: done });
			stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: done });
			stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: done });
			stream.push({ type: "done", reason: "stop", message: done });
		} catch (error) {
			const failed = assistant(model, "", "error");
			failed.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: failed });
		}
	})();

	return stream;
}

async function jsonBody(request: Request) {
	return request.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function codeTool(env: Env, onExecute: () => void): AgentTool {
	return {
		name: "execute_js",
		label: "Execute JavaScript",
		description: "Run generated JavaScript in an isolated Dynamic Worker sandbox. Use this for calculations or small data transformations. The code must be an async arrow function and network access is blocked.",
		parameters: Type.Object({
			code: Type.String({ description: "An async arrow function, for example: async () => 2 + 2" }),
		}),
		execute: async (_toolCallId, params) => {
			onExecute();
			const { code } = params as { code: string };
			const executor = new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null, timeout: 10_000 });
			const result = await executor.execute(code, {});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ result: result.result, error: result.error, logs: result.logs ?? [] }, null, 2),
					},
				],
				details: result,
			};
		},
	};
}

export class PiAgent extends Agent<Env, State> {
	initialState: State = { requests: 0 };

	status() {
		const reasoningEffort = reasoningEffortFromEnv(this.env);
		return {
			ok: true,
			model: this.env.PI_MODEL,
			gateway: this.env.AI_GATEWAY_ID,
			reasoningEffort,
			thinkingLevel: thinkingLevelFromEffort(reasoningEffort),
			durableExecution: "runFiber",
			requests: this.state.requests,
			codeExecutions: this.state.codeExecutions ?? 0,
			recoveries: this.state.recoveries ?? 0,
			lastRecoveredAnswer: this.state.lastRecoveredAnswer,
		};
	}

	private async completeTurn(prompt: string) {
		const reasoningEffort = reasoningEffortFromEnv(this.env);
		const model = modelFromGatewayName(this.env.PI_MODEL, reasoningEffort);
		let codeExecutions = 0;
		const pi = new Pi({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
				model,
				thinkingLevel: thinkingLevelFromEffort(reasoningEffort),
				tools: [codeTool(this.env, () => codeExecutions++)],
			},
			streamFn: (_model, context) => streamFromGateway(this.env, model, context),
		});

		let answer = "";
		const unsubscribe = pi.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") answer += event.assistantMessageEvent.delta;
		});

		try {
			await pi.prompt(prompt);
			return { answer, model: model.name, reasoningEffort, codeExecutions };
		} finally {
			unsubscribe();
		}
	}

	async runTurn(input: string) {
		const prompt = input.trim();
		if (!prompt) throw new Error("Missing prompt");

		return await this.runFiber("pi-prompt", async (fiber) => {
			fiber.stash({ prompt });
			const result = await this.completeTurn(prompt);
			this.setState({
				requests: this.state.requests + 1,
				codeExecutions: (this.state.codeExecutions ?? 0) + result.codeExecutions,
			});
			return result;
		});
	}

	async onFiberRecovered(ctx: FiberRecoveryContext) {
		if (ctx.name !== "pi-prompt") return;

		const snapshot = ctx.snapshot as { prompt?: unknown } | null;
		if (typeof snapshot?.prompt !== "string") return;

		const { answer, codeExecutions } = await this.completeTurn(snapshot.prompt);
		this.setState({
			requests: this.state.requests + 1,
			codeExecutions: (this.state.codeExecutions ?? 0) + codeExecutions,
			recoveries: (this.state.recoveries ?? 0) + 1,
			lastRecoveredAnswer: answer,
		});
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const agent = await getAgentByName(env.PiAgent, "default");

		if (request.method === "GET" && url.pathname === "/api/status") return Response.json(await agent.status());
		if (request.method === "POST" && url.pathname === "/api/prompt") {
			const body = await jsonBody(request);
			const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
			if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 });

			try {
				return Response.json(await agent.runTurn(prompt));
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
