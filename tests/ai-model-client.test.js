const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOKENHUB_ENDPOINT,
  createModelGateway,
} = require("../cloudfunctions/ai/model-client");

const testTokenHubKey = ["test", "tokenhub", "key", "1234567890"].join("-");

const messages = [{
  role: "user",
  content: [
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
    { type: "text", text: "只输出 JSON" },
  ],
}];

function createTransport(response, capture) {
  return async (request) => {
    capture.push(request);
    return response;
  };
}

test("Qwen TokenHub 请求固定官方端点并关闭思考与启用严格结构化输出", async () => {
  const calls = [];
  const gateway = createModelGateway({
    cloudbaseApp: {},
    tokenHubTransport: createTransport({
      statusCode: 200,
      body: JSON.stringify({ choices: [{ message: { content: "{\"drafts\":[]}" }, finish_reason: "stop" }] }),
    }, calls),
  });
  const response = await gateway.generate({
    provider: "tokenhub",
    model: "qwen3.5-flash",
    apiKey: testTokenHubKey,
  }, { messages, max_tokens: 4000 });

  assert.equal(response.choices[0].message.content, '{"drafts":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKENHUB_ENDPOINT);
  assert.equal(calls[0].headers.Authorization, `Bearer ${testTokenHubKey}`);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "qwen3.5-flash");
  assert.equal(body.stream, false);
  assert.equal(body.max_completion_tokens, 4000);
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.messages[0].content[0].image_url.url, "data:image/jpeg;base64,/9j/");
});

test("GLM TokenHub 对照模型使用低推理强度和 JSON 对象输出", async () => {
  const calls = [];
  const gateway = createModelGateway({
    cloudbaseApp: {},
    tokenHubTransport: createTransport({
      statusCode: 200,
      body: JSON.stringify({ choices: [{ message: { content: "{\"drafts\":[]}" }, finish_reason: "stop" }] }),
    }, calls),
  });
  await gateway.generate({
    provider: "tokenhub",
    model: "glm-5.3-flash",
    apiKey: testTokenHubKey,
  }, { messages, max_tokens: 4000 });

  const body = JSON.parse(calls[0].body);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("TokenHub 非成功响应、超大响应和非法 JSON 映射为稳定内部错误", async () => {
  for (const [response, expected] of [
    [{ statusCode: 401, body: '{"error":{"message":"secret upstream payload"}}' }, "MODEL_AUTHENTICATION_FAILED"],
    [{ statusCode: 429, body: '{"error":{"message":"quota exhausted"}}' }, "MODEL_RATE_LIMITED"],
    [{ statusCode: 500, body: "upstream failed" }, "MODEL_REQUEST_FAILED"],
    [{ statusCode: 200, body: "not-json" }, "INVALID_MODEL_OUTPUT"],
    [{ statusCode: 200, body: "x".repeat(512 * 1024 + 1) }, "MODEL_RESPONSE_TOO_LARGE"],
  ]) {
    const gateway = createModelGateway({
      cloudbaseApp: {},
      tokenHubTransport: createTransport(response, []),
    });
    await assert.rejects(gateway.generate({
      provider: "tokenhub",
      model: "qwen3.5-flash",
      apiKey: testTokenHubKey,
    }, { messages, max_tokens: 4000 }), { message: expected });
  }
});

test("CloudBase 回滚通道保持原请求格式", async () => {
  const calls = [];
  const gateway = createModelGateway({
    cloudbaseApp: {
      ai() {
        return { createModel(provider) {
          assert.equal(provider, "cloudbase");
          return { async generateText(input) {
            calls.push(input);
            return { text: "ok" };
          } };
        } };
      },
    },
  });
  const response = await gateway.generate({ provider: "cloudbase", model: "glm-5v-turbo" }, {
    messages,
    max_tokens: 4000,
  });
  assert.equal(response.text, "ok");
  assert.equal(calls[0].model, "glm-5v-turbo");
  assert.equal(calls[0].max_tokens, 4000);
});

test("TokenHub 适配层再次拒绝未知模型和无效密钥", async () => {
  const gateway = createModelGateway({ cloudbaseApp: {}, tokenHubTransport: createTransport({
    statusCode: 200,
    body: "{}",
  }, []) });
  for (const configuration of [
    { provider: "tokenhub", model: "unknown-model", apiKey: testTokenHubKey },
    { provider: "tokenhub", model: "qwen3.5-flash", apiKey: "short" },
  ]) {
    await assert.rejects(gateway.generate(configuration, { messages, max_tokens: 4000 }), {
      message: "CONFIGURATION",
    });
  }
});
