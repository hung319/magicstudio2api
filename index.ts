/**
 * =================================================================================
 * ✨ MagicStudio-2API (Bun Edition) ✨
 * =================================================================================
 *
 * Migration to Bun:
 * - Removed Frontend UI
 * - Added .env support
 * - Switched to Bun.serve()
 */

const PORT = process.env.PORT || 3000;

// =================================================================
// ⚙️ Cấu hình từ Environment Variables
// =================================================================

const CONFIG = {
  API_KEY: process.env.API_KEY || "default-unsafe-key",
  DEFAULT_MODEL: "magic-art-generator",
  KNOWN_MODELS: ["magic-art-generator"],
  UPSTREAM_URL: process.env.UPSTREAM_URL || "https://ai-api.magicstudio.com/api/ai-art-generator",
  UPSTREAM_CLIENT_ID: process.env.UPSTREAM_CLIENT_ID || "pSgX7WgjukXCBoYwDM8G8GLnRRkvAoJlqa5eAVvj95o"
};

console.log(`🚀 MagicStudio Service starting on port ${PORT}...`);

// =================================================================
// 🚀 Server Entry Point (Bun.serve)
// =================================================================

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      // 1. Health Check (Root)
      if (pathname === "/") {
        return new Response(JSON.stringify({
          status: "ok",
          service: "MagicStudio-2API-Bun",
          version: "2.0.2-bun"
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // 2. API Routing (/v1/*)
      if (pathname.startsWith("/v1/")) {
        return await handleApiRequest(req, pathname);
      }

      // 3. 404 Not Found
      return new Response(JSON.stringify({ error: "Not Found" }), { 
        status: 404, 
        headers: { "Content-Type": "application/json" } 
      });

    } catch (error) {
      console.error(`[Global Error]`, error);
      return new Response(JSON.stringify({ error: `Internal Server Error: ${error.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },
});

/**
 * Xử lý logic API chính
 */
async function handleApiRequest(request, pathname) {
  const responseHeaders = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });

  // Handle Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  // --- Auth Check ---
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.substring(7) !== CONFIG.API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing API Key." }), {
      status: 401,
      headers: responseHeaders,
    });
  }

  // --- Routing ---
  if (pathname === "/v1/models" && request.method === "GET") {
    return handleListModels(responseHeaders);
  }
  
  if (pathname === "/v1/images/generations" && request.method === "POST") {
    return handleImageGenerations(request, responseHeaders);
  }

  if (pathname === "/v1/chat/completions" && request.method === "POST") {
    return handleChatCompletions(request, responseHeaders);
  }

  return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for ${pathname}` }), {
    status: 405,
    headers: responseHeaders,
  });
}

// =================================================================
// 🧠 Handlers
// =================================================================

function handleListModels(baseHeaders) {
  const modelsData = {
    object: "list",
    data: CONFIG.KNOWN_MODELS.map(name => ({
      id: name,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "MagicStudio-Bun",
    })),
  };
  return new Response(JSON.stringify(modelsData), { headers: baseHeaders });
}

async function handleImageGenerations(request, baseHeaders) {
  let requestData;
  try {
    requestData = await request.json();
  } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: baseHeaders });
  }

  const { prompt, n = 1, response_format = "b64_json" } = requestData;

  if (!prompt) {
    return new Response(JSON.stringify({ error: "Missing 'prompt' parameter." }), { status: 400, headers: baseHeaders });
  }

  const imageResults = await generateImagesFromUpstream(prompt, n);

  if (imageResults.every(res => res.status === 'rejected')) {
    return new Response(JSON.stringify({ error: "Upstream generation failed." }), { status: 502, headers: baseHeaders });
  }

  const successfulB64s = imageResults
    .filter(res => res.status === 'fulfilled')
    .map(res => res.value)
    .filter(Boolean);

  const responseData = {
    created: Math.floor(Date.now() / 1000),
    data: successfulB64s.map(b64_json => ({ b64_json })),
  };

  return new Response(JSON.stringify(responseData), { headers: baseHeaders });
}

async function handleChatCompletions(request, baseHeaders) {
  let requestData;
  try {
    requestData = await request.json();
  } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: baseHeaders });
  }
  
  const { messages, model = CONFIG.DEFAULT_MODEL, stream = false } = requestData;

  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ error: "Missing 'messages' in body." }), { status: 400, headers: baseHeaders });
  }

  const lastUserMessage = messages.filter(m => m.role === 'user').pop();
  if (!lastUserMessage || !lastUserMessage.content) {
    return new Response(JSON.stringify({ error: "No user message found." }), { status: 400, headers: baseHeaders });
  }

  const prompt = lastUserMessage.content;
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  // --- STREAMING MODE ---
  if (stream) {
    // Sử dụng TransformStream để giữ logic streaming cũ nhưng chạy trên Bun
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendChunk = (data) => {
      writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };

    // Chạy background task generate ảnh
    (async () => {
      try {
        // 1. Initial empty chunk
        sendChunk(createChatChunk(requestId, model, ""));

        // 2. Call Upstream
        const imageResults = await generateImagesFromUpstream(prompt, 1);
        const successfulResult = imageResults.find(res => res.status === 'fulfilled');

        if (successfulResult) {
            const b64_json = successfulResult.value;
            // Markdown image format
            const responseContent = `![](data:image/png;base64,${b64_json})`;
            sendChunk(createChatChunk(requestId, model, responseContent));
        } else {
            throw new Error("Upstream generation failed.");
        }

        // 3. Stop chunk
        sendChunk(createChatChunk(requestId, model, null, "stop"));
        
        // 4. DONE signal
        writer.write(encoder.encode("data: [DONE]\n\n"));

      } catch (e) {
        console.error("Streaming Error:", e);
        const errorPayload = { error: { message: e.message, type: "server_error" } };
        writer.write(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
        writer.write(encoder.encode("data: [DONE]\n\n"));
      } finally {
        writer.close();
      }
    })();

    // Trả về stream ngay lập tức
    baseHeaders.set("Content-Type", "text/event-stream");
    baseHeaders.set("Cache-Control", "no-cache");
    baseHeaders.set("Connection", "keep-alive");
    return new Response(readable, { headers: baseHeaders });
  }

  // --- NORMAL MODE ---
  const imageResults = await generateImagesFromUpstream(prompt, 1);
  const successfulResult = imageResults.find(res => res.status === 'fulfilled');

  if (successfulResult) {
    const b64_json = successfulResult.value;
    const responseContent = `![](data:image/png;base64,${b64_json})`;

    const chatResponse = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: responseContent },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(chatResponse), { headers: baseHeaders });
  } else {
    return new Response(JSON.stringify({ error: "Upstream generation failed." }), { status: 502, headers: baseHeaders });
  }
}

// =================================================================
// 🛠️ Helpers
// =================================================================

async function generateImagesFromUpstream(prompt, n) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://magicstudio.com",
    "Referer": "https://magicstudio.com/",
    "User-Agent": "Mozilla/5.0 (compatible; Bun/1.0)",
  };

  const createRequestBody = () => {
    const formData = new FormData();
    formData.append("prompt", prompt);
    formData.append("output_format", "bytes");
    formData.append("user_profile_id", "null");
    formData.append("anonymous_user_id", crypto.randomUUID());
    formData.append("request_timestamp", String(Date.now()));
    formData.append("user_is_subscribed", "false");
    formData.append("client_id", CONFIG.UPSTREAM_CLIENT_ID);
    return formData;
  };

  const tasks = Array(n).fill(0).map(() =>
    fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: headers,
      body: createRequestBody(),
    }).then(async (response) => {
      if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Upstream ${response.status}: ${txt}`);
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("image")) {
        throw new Error(`Upstream returned non-image: ${contentType}`);
      }
      const imageBuffer = await response.arrayBuffer();
      return Buffer.from(imageBuffer).toString('base64'); // Bun supports Buffer directly
    })
  );

  return Promise.allSettled(tasks);
}

function createChatChunk(id, model, content, finish_reason = null) {
  const chunk = {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: {}, finish_reason: finish_reason }],
  };
  if (content !== null) chunk.choices[0].delta.content = content;
  return chunk;
}
