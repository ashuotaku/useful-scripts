const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// --- CONFIGURATION ---
const LOCAL_PORT = 3001;
const TARGET_BASE = 'http://localhost:8080'; 

// --- HELPER: Normalize Model List ---
// SillyTavern expects: { data: [ { id: "name" }, ... ] }
function formatModels(backendData) {
    // Case 1: Already in OpenAI format { data: [...] }
    if (backendData.data && Array.isArray(backendData.data)) {
        return backendData;
    }
    
    // Case 2: Simple Array ["model1", "model2"]
    if (Array.isArray(backendData)) {
        return {
            object: "list",
            data: backendData.map(id => ({
                id: id,
                object: "model",
                created: Date.now(),
                owned_by: "proxy"
            }))
        };
    }

    // Case 3: Anthropic format or unknown, try to find an array
    const possibleArray = Object.values(backendData).find(v => Array.isArray(v));
    if (possibleArray) {
        return {
            object: "list",
            data: possibleArray.map(m => ({
                id: m.id || m.model || m.name || "unknown-model",
                object: "model",
                created: Date.now(),
                owned_by: "proxy"
            }))
        };
    }

    throw new Error("Unknown model list format");
}

// --- 1. MODELS ENDPOINT ---
app.get('/v1/models', async (req, res) => {
    try {
        let responseData;
        
        // Try /v1/models first (Standard)
        try {
            console.log(`[Proxy] Fetching models from ${TARGET_BASE}/v1/models...`);
            const response = await axios.get(`${TARGET_BASE}/v1/models`);
            responseData = response.data;
        } catch (e1) {
            // If failed, try /models (Alternative)
            try {
                console.log(`[Proxy] /v1/models failed. Trying ${TARGET_BASE}/models...`);
                const response = await axios.get(`${TARGET_BASE}/models`);
                responseData = response.data;
            } catch (e2) {
                throw new Error("Could not fetch models from backend.");
            }
        }

        const formatted = formatModels(responseData);
        res.json(formatted);

    } catch (error) {
        console.error("Model Fetch Error:", error.message);
        // FALLBACK: Return a dummy model so SillyTavern doesn't show an empty list
        res.json({
            object: "list",
            data: [
                { id: "Manual-Model-Entry", object: "model" },
                { id: "claude-3-opus", object: "model" },
                { id: "claude-3-sonnet", object: "model" }
            ]
        });
    }
});

// --- 2. CHAT COMPLETION ENDPOINT (STREAMING) ---
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const openaiBody = req.body;
        const isStreaming = openaiBody.stream === true;
        const targetUrl = `${TARGET_BASE}/v1/messages`;

        // Convert Messages
        let systemPrompt = '';
        const anthropicMessages = [];

        if (openaiBody.messages) {
            for (const msg of openaiBody.messages) {
                if (msg.role === 'system') {
                    systemPrompt += msg.content + '\n';
                } else {
                    anthropicMessages.push({
                        role: msg.role,
                        content: msg.content
                    });
                }
            }
        }

        const anthropicBody = {
            model: openaiBody.model,
            messages: anthropicMessages,
            system: systemPrompt.trim(),
            max_tokens: openaiBody.max_tokens || 4096,
            temperature: openaiBody.temperature,
            stream: isStreaming 
        };

        console.log(`[Proxy] Forwarding ${isStreaming ? 'STREAMING' : 'BLOCK'} request to ${targetUrl}`);

        if (isStreaming) {
            const response = await axios.post(targetUrl, anthropicBody, {
                headers: { 'Content-Type': 'application/json' },
                responseType: 'stream'
            });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const stream = response.data;

            stream.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;
                    if (trimmedLine.startsWith('data: ')) {
                        const jsonStr = trimmedLine.replace('data: ', '');
                        try {
                            const data = JSON.parse(jsonStr);
                            if (data.type === 'content_block_delta' && data.delta?.text) {
                                res.write(`data: ${JSON.stringify({
                                    id: "chatcmpl-stream",
                                    object: "chat.completion.chunk",
                                    created: Date.now(),
                                    model: openaiBody.model,
                                    choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }]
                                })}\n\n`);
                            }
                            if (data.type === 'message_stop') {
                                res.write(`data: ${JSON.stringify({
                                    id: "chatcmpl-stream",
                                    object: "chat.completion.chunk",
                                    created: Date.now(),
                                    model: openaiBody.model,
                                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                                })}\n\n`);
                                res.write('data: [DONE]\n\n');
                                res.end();
                            }
                        } catch (e) {}
                    }
                }
            });

        } else {
            // Non-Streaming
            const response = await axios.post(targetUrl, anthropicBody);
            const content = response.data.content?.[0]?.text || "";
            res.json({
                id: response.data.id,
                object: "chat.completion",
                created: Date.now(),
                model: response.data.model,
                choices: [{ message: { role: "assistant", content: content }, finish_reason: "stop" }]
            });
        }

    } catch (error) {
        console.error("Proxy Error:", error.message);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

app.listen(LOCAL_PORT, () => {
    console.log(`\n🚀 Proxy running on http://localhost:${LOCAL_PORT}`);
});