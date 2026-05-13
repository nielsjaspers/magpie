import { describe, expect, test } from "bun:test";
import { randomDelay, randomVerb } from "../spinner/spinner.js";
import { SPINNER_VERBS } from "../spinner/verbs.js";

describe("spinner helpers", () => {
	test("keeps delay within the intended rotation window", () => {
		for (let i = 0; i < 100; i++) {
			const delay = randomDelay();
			expect(delay).toBeGreaterThanOrEqual(6000);
			expect(delay).toBeLessThan(10000);
		}
	});

	test("returns known spinner text", () => {
		const verb = randomVerb();
		expect(SPINNER_VERBS.includes(verb) || verb.includes("stuck in the computer")).toBe(true);
		expect(SPINNER_VERBS.length).toBeGreaterThan(50);
	});
});
