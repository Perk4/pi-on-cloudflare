import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Pi Agent worker", () => {
	it("serves the minimal HTML interface as a static asset", async () => {
		const response = await SELF.fetch("https://example.com/");

		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("Pi Agent on Cloudflare");
	});

	it("reports status through the public API", async () => {
		const response = await SELF.fetch("https://example.com/api/status");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			model: "openai/gpt-5.6-luna",
			gateway: "default",
			reasoningEffort: "high",
			thinkingLevel: "high",
			durableExecution: "runFiber",
			requests: 0,
			codeExecutions: 0,
		});
	});

	it("validates prompts before calling AI Gateway", async () => {
		const response = await SELF.fetch("https://example.com/api/prompt", { method: "POST", body: "{}" });
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body).toMatchObject({ error: "Missing prompt" });
	});
});
