import { getModelConfig } from "./src/models.js";
const cfg = await getModelConfig("Qwen/Qwen3-Embedding-4B-GGUF");
console.log("getModelConfig result:");
console.log(JSON.stringify(cfg, null, 2));
