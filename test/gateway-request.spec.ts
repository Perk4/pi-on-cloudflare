import { Type, type AssistantMessage, type Context, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { gatewayRequestBody } from "../src/gateway-request";

const executeJs: Tool = {
	name: "execute_js",
	description: "Run generated JavaScript",
	parameters: Type.Object({
		code: Type.String({ description: "An async arrow function" }),
	}),
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-luna",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

describe("Responses-only AI Gateway request", () => {
	it("sends input and reasoning without Chat Completions messages", () => {
		const context: Context = {
			systemPrompt: "You are a concise assistant.",
			messages: [{ role: "user", content: "Reply with pong.", timestamp: 1 }],
			tools: [executeJs],
		};

		const body = gatewayRequestBody(context, "high");

		expect(body).toEqual({
			input: [{ role: "user", content: "Reply with pong." }],
			reasoning: { effort: "high" },
			instructions: "You are a concise assistant.",
			tools: [
				{
					type: "function",
					name: "execute_js",
					description: "Run generated JavaScript",
					parameters: executeJs.parameters,
					strict: false,
				},
			],
		});
		expect(body).not.toHaveProperty("messages");
	});

	it("serializes execute_js history as function_call and function_call_output items", () => {
		const context: Context = {
			systemPrompt: "You are a concise assistant.",
			messages: [
				{ role: "user", content: "What is 2+2?", timestamp: 1 },
				assistantToolCall("call_abc", "execute_js", { code: "async () => 4" }),
				{
					role: "toolResult",
					toolCallId: "call_abc",
					toolName: "execute_js",
					content: [{ type: "text", text: '{"result":4}' }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [executeJs],
		};

		const body = gatewayRequestBody(context, "high");
		const input = body.input;

		expect(input).toEqual([
			{ role: "user", content: "What is 2+2?" },
			{
				type: "function_call",
				call_id: "call_abc",
				name: "execute_js",
				arguments: JSON.stringify({ code: "async () => 4" }),
			},
			{
				type: "function_call_output",
				call_id: "call_abc",
				output: '{"result":4}',
			},
		]);
		expect(JSON.stringify(input)).not.toContain("tool_calls");
		expect(JSON.stringify(input)).not.toContain('"role":"tool"');
		expect(JSON.stringify(input)).not.toContain("tool_call_id");
	});

	it("emits only the Responses function-tool shape", () => {
		const body = gatewayRequestBody(
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [executeJs],
			},
			"high",
		);

		expect(body.tools).toHaveLength(1);
		const tool = body.tools?.[0];
		expect(tool).toMatchObject({
			type: "function",
			name: "execute_js",
			description: "Run generated JavaScript",
			strict: false,
		});
		expect(tool).not.toHaveProperty("function");
		expect(tool?.parameters).toBe(executeJs.parameters);
	});
});
