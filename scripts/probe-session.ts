// Probe: real pi session against opencode-go/deepseek-v4-flash, one turn.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime } from "../src/agent/pi-runtime.js";
import { loadModels } from "../src/models/directory.js";
import { readFileSync } from "node:fs";

const entries = loadModels(JSON.parse(readFileSync("models.json", "utf-8")));
const models = new Map(entries.map((e) => [e.name, e.spec]));
const piRuntime = await ModelRuntime.create({ refreshOnCreate: false });
const rt = new PiAgentRuntime({ runtime: piRuntime, models });

const spec = models.get("opencode-go-ds4-flash")!;
console.log(`resolving ${spec.provider}/${spec.model} ...`);
const resolved = piRuntime.getModel(spec.provider, spec.model);
console.log("getModel:", resolved ? `${resolved.provider}/${resolved.id}` : "null");

const session = await rt.createSession({
  model: "opencode-go-ds4-flash",
  prompt: "Reply with exactly: PROBE_OK",
});
const result = await session.prompt("Reply with exactly: PROBE_OK");
console.log("finalText:", JSON.stringify(result.finalText.slice(0, 80)));
console.log("usage:", JSON.stringify(result.usage));
session.dispose();
console.log("probe done");
