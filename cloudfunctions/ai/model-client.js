const https = require("node:https");

const TOKENHUB_ENDPOINT = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const TOKENHUB_TIMEOUT_MS = 60000;
const MAX_TOKENHUB_RESPONSE_BYTES = 512 * 1024;
const TOKENHUB_MODELS = new Set(["qwen3.5-flash", "glm-5.3-flash"]);
const TOKENHUB_API_KEY_PATTERN = /^[\x21-\x7e]{20,512}$/;
const SAFE_TRANSPORT_ERRORS = new Set([
  "MODEL_AUTHENTICATION_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_REQUEST_FAILED",
  "MODEL_RESPONSE_TOO_LARGE",
  "MODEL_TIMEOUT",
]);

const HOMEWORK_IMPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sourceType", "detectedScope", "weekLabel", "truncated", "drafts"],
  properties: {
    sourceType: { type: "string", enum: ["weekly_table", "daily_list", "chat", "unknown"] },
    detectedScope: {
      type: "string",
      enum: ["", "monday", "tuesday", "wednesday", "thursday", "friday_weekend"],
    },
    weekLabel: { type: "string" },
    truncated: { type: "boolean" },
    drafts: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "subject",
          "title",
          "content",
          "extraRequirement",
          "deadlineExplicit",
          "deadline",
          "uncertainFields",
        ],
        properties: {
          subject: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          extraRequirement: { type: "string" },
          deadlineExplicit: { type: "boolean" },
          deadline: { type: "string" },
          uncertainFields: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: ["subject", "title", "content", "extraRequirement", "deadline"],
            },
          },
        },
      },
    },
  },
};

function requestTokenHub({ url, headers, body, timeoutMs = TOKENHUB_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const deadline = setTimeout(() => {
      if (request) request.destroy(new Error("MODEL_TIMEOUT"));
    }, timeoutMs);
    request = https.request(url, { method: "POST", headers }, (response) => {
      const chunks = [];
      let size = 0;
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > MAX_TOKENHUB_RESPONSE_BYTES) {
        response.destroy();
        finish(reject, new Error("MODEL_RESPONSE_TOO_LARGE"));
        return;
      }
      response.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_TOKENHUB_RESPONSE_BYTES) {
          response.destroy();
          finish(reject, new Error("MODEL_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish(resolve, {
          statusCode: Number(response.statusCode) || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", () => {
        finish(reject, new Error("MODEL_REQUEST_FAILED"));
      });
    });
    request.on("error", (error) => {
      finish(reject, new Error(error && error.message === "MODEL_TIMEOUT" ? "MODEL_TIMEOUT" : "MODEL_REQUEST_FAILED"));
    });
    request.end(body);
  });
}

function buildTokenHubBody(configuration, input) {
  if (!configuration || !TOKENHUB_MODELS.has(configuration.model)
    || !TOKENHUB_API_KEY_PATTERN.test(configuration.apiKey || "")
    || !input || !Array.isArray(input.messages)
    || !Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1) {
    throw new Error("CONFIGURATION");
  }
  const body = {
    model: configuration.model,
    messages: input.messages,
    stream: false,
    temperature: 0.1,
    max_completion_tokens: input.max_tokens,
  };
  if (configuration.model === "qwen3.5-flash") {
    body.thinking = { type: "disabled" };
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "homework_import",
        strict: true,
        schema: HOMEWORK_IMPORT_SCHEMA,
      },
    };
  } else {
    body.reasoning_effort = "low";
    body.response_format = { type: "json_object" };
  }
  return body;
}

function statusError(statusCode) {
  if (statusCode === 401 || statusCode === 403) return new Error("MODEL_AUTHENTICATION_FAILED");
  if (statusCode === 429) return new Error("MODEL_RATE_LIMITED");
  return new Error("MODEL_REQUEST_FAILED");
}

async function generateWithTokenHub(configuration, input, transport) {
  const body = JSON.stringify(buildTokenHubBody(configuration, input));
  let response;
  try {
    response = await transport({
      url: TOKENHUB_ENDPOINT,
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
      timeoutMs: TOKENHUB_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(SAFE_TRANSPORT_ERRORS.has(error && error.message)
      ? error.message
      : "MODEL_REQUEST_FAILED");
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    throw statusError(response && response.statusCode);
  }
  if (typeof response.body !== "string"
    || Buffer.byteLength(response.body, "utf8") > MAX_TOKENHUB_RESPONSE_BYTES) {
    throw new Error("MODEL_RESPONSE_TOO_LARGE");
  }
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error("INVALID_MODEL_OUTPUT");
  }
}

function createModelGateway({ cloudbaseApp, tokenHubTransport = requestTokenHub }) {
  return {
    async generate(configuration, input) {
      if (configuration.provider === "cloudbase") {
        const model = cloudbaseApp.ai().createModel("cloudbase");
        return model.generateText({ ...input, model: configuration.model });
      }
      if (configuration.provider === "tokenhub") {
        return generateWithTokenHub(configuration, input, tokenHubTransport);
      }
      throw new Error("CONFIGURATION");
    },
  };
}

module.exports = {
  TOKENHUB_ENDPOINT,
  HOMEWORK_IMPORT_SCHEMA,
  createModelGateway,
};
