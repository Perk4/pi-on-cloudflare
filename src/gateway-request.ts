import type { Context, Tool } from "@earendil-works/pi-ai";

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ResponsesInputItem =
	| { role: "user" | "assistant"; content: string }
	| { type: "function_call"; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string };

export type ResponsesFunctionTool = {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: false;
};

export type GatewayResponsesRequest = {
	input: ResponsesInputItem[];
	reasoning: { effort: ReasoningEffort };
	instructions?: string;
	tools?: ResponsesFunctionTool[];
};

export function isReasoningEffort(value: string): value is ReasoningEffort {
	return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			if (!("type" in part) || part.type !== "text") return "";
			if (!("text" in part) || typeof part.text !== "string") return "";
			return part.text;
		})
		.join("\n");
}

export function responsesInput(context: Context): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];

	for (const message of context.messages) {
		switch (message.role) {
			case "toolResult": {
				items.push({
					type: "function_call_output",
					call_id: message.toolCallId.split("|")[0] ?? message.toolCallId,
					output: text(message.content),
				});
				break;
			}
			case "assistant": {
				const body = text(message.content);
				if (body) {
					items.push({ role: "assistant", content: body });
				}
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					items.push({
						type: "function_call",
						call_id: part.id.split("|")[0] ?? part.id,
						name: part.name,
						arguments: JSON.stringify(part.arguments),
					});
				}
				break;
			}
			case "user": {
				items.push({ role: "user", content: text(message.content) });
				break;
			}
			default: {
				const exhaustive: never = message;
				throw new Error(`Unhandled context message role: ${(exhaustive as { role: string }).role}`);
			}
		}
	}

	return items;
}

export function toolsForGateway(tools: Tool[] | undefined): ResponsesFunctionTool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		strict: false,
	}));
}

export function gatewayRequestBody(context: Context, reasoningEffort: ReasoningEffort): GatewayResponsesRequest {
	const tools = toolsForGateway(context.tools);
	return {
		input: responsesInput(context),
		reasoning: { effort: reasoningEffort },
		...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
		...(tools ? { tools } : {}),
	};
}
