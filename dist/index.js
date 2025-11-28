#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
const VERSION = typeof pkg.version === "string" ? pkg.version : "0.1.0";
const DEFAULT_BASE = sanitizeBaseUrl(process.env.IMAGE2URL_BASE_URL ?? "https://www.image2url.com");
const DEFAULT_UPLOAD_PATH = normalizePath(process.env.IMAGE2URL_UPLOAD_PATH ?? "/api/upload");
const UPLOAD_URL = process.env.IMAGE2URL_UPLOAD_URL ?? `${DEFAULT_BASE}${DEFAULT_UPLOAD_PATH}`;
const API_TOKEN = process.env.IMAGE2URL_API_TOKEN;
const MAX_BYTES = Number.parseInt(process.env.IMAGE2URL_MAX_BYTES ?? "", 10) ||
    2 * 1024 * 1024; // align with hosted limit
const TIMEOUT_MS = Number.parseInt(process.env.IMAGE2URL_TIMEOUT_MS ?? "", 10) || 20_000;
const DEBUG = process.env.IMAGE2URL_DEBUG === "1";
const USER_AGENT = `mcp-server-image2url/${VERSION}`;
const uploadInputSchema = z
    .object({
    path: z
        .string()
        .trim()
        .optional()
        .describe("Local image file path to upload."),
    url: z
        .string()
        .url()
        .optional()
        .describe("Remote image URL to fetch and re-upload."),
    alt: z.string().optional().describe("Alt text for generated snippets."),
    format: z
        .enum(["all", "markdown", "html", "url", "bbcode"])
        .default("all")
        .describe("Which snippet format to highlight in the text response."),
})
    .refine((value) => value.path || value.url, {
    message: "Provide either a local file path or a remote image URL.",
});
const uploadOutputSchema = z.object({
    url: z.string().url(),
    markdown: z.string(),
    html: z.string(),
    bbcode: z.string(),
    alt: z.string().optional(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    source: z.enum(["local", "remote"]),
    uploadEndpoint: z.string().url(),
    uploadedAt: z.string(),
});
const server = new McpServer({
    name: "mcp-server-image2url",
    version: VERSION,
}, {
    instructions: "One-command setup: add {\"command\": \"npx\", \"args\": [\"-y\", \"mcp-server-image2url\"]} to your MCP client. No API key needed; default endpoint uses IP-based free quota at image2url.com. Override with IMAGE2URL_BASE_URL or IMAGE2URL_UPLOAD_URL when self-hosting.",
    capabilities: {
        logging: {},
    },
});
server.registerTool("upload_image", {
    title: "Upload image to image2url",
    description: "Upload a local file or remote image URL to image2url.com and get ready-to-paste snippets.",
    inputSchema: uploadInputSchema,
    outputSchema: uploadOutputSchema,
}, async (rawArgs) => {
    try {
        const args = uploadInputSchema.parse(rawArgs);
        const format = args.format ?? "all";
        const source = args.path
            ? await readLocalFile(args.path)
            : await fetchRemoteImage(args.url);
        const uploadResult = await uploadToImage2Url(source);
        const alt = (args.alt || source.originalName || "image").trim();
        const snippets = buildSnippets(uploadResult.url, alt);
        const structuredContent = {
            url: uploadResult.url,
            markdown: snippets.markdown,
            html: snippets.html,
            bbcode: snippets.bbcode,
            alt,
            filename: source.originalName,
            mimeType: source.mimeType,
            size: source.size,
            source: source.source,
            uploadEndpoint: UPLOAD_URL,
            uploadedAt: uploadResult.uploadedAt ?? new Date().toISOString(),
        };
        return {
            content: [
                {
                    type: "text",
                    text: formatResponse(structuredContent, format),
                },
            ],
            structuredContent,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upload error";
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `image2url upload failed: ${message}`,
                },
            ],
        };
    }
});
async function readLocalFile(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
        throw new Error("Path is not a file.");
    }
    if (stat.size > MAX_BYTES) {
        throw new Error(`File is too large. Limit: ${formatBytes(MAX_BYTES)}, got ${formatBytes(stat.size)}`);
    }
    const buffer = await fs.readFile(absolutePath);
    const mimeType = mime.lookup(absolutePath) || "application/octet-stream";
    if (!mimeType.startsWith("image/")) {
        throw new Error(`Only image files are supported (detected ${mimeType}).`);
    }
    return {
        buffer,
        originalName: path.basename(absolutePath),
        mimeType,
        size: buffer.length,
        source: "local",
    };
}
async function fetchRemoteImage(url) {
    const controller = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url, { signal: controller });
    if (!response.ok) {
        throw new Error(`Failed to fetch remote image (${response.status}).`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BYTES) {
        throw new Error(`Remote image exceeds limit. Limit: ${formatBytes(MAX_BYTES)}, reported ${formatBytes(Number.parseInt(contentLength, 10))}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_BYTES) {
        throw new Error(`Remote image exceeds limit. Limit: ${formatBytes(MAX_BYTES)}, got ${formatBytes(buffer.length)}`);
    }
    const contentType = response.headers.get("content-type") ||
        mime.lookup(url) ||
        "application/octet-stream";
    if (!contentType.startsWith("image/")) {
        throw new Error(`Only image content types are supported (detected ${contentType}).`);
    }
    const urlPath = new URL(url).pathname;
    const originalName = path.basename(urlPath) || "remote-image";
    return {
        buffer,
        originalName,
        mimeType: contentType,
        size: buffer.length,
        source: "remote",
    };
}
async function uploadToImage2Url(source) {
    const controller = AbortSignal.timeout(TIMEOUT_MS);
    const form = new FormData();
    const arrayBuffer = source.buffer.buffer.slice(source.buffer.byteOffset, source.buffer.byteOffset + source.buffer.byteLength);
    const blob = new Blob([arrayBuffer], { type: source.mimeType });
    const file = new File([blob], source.originalName, {
        type: source.mimeType,
    });
    form.append("file", file);
    const response = await fetch(UPLOAD_URL, {
        method: "POST",
        body: form,
        signal: controller,
        headers: {
            "User-Agent": USER_AGENT,
            ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        },
    });
    const responseText = await response.text();
    logDebug("Upload response", response.status, responseText);
    let data = {};
    if (responseText) {
        try {
            data = JSON.parse(responseText);
        }
        catch {
            throw new Error(`Unexpected response from image2url: ${response.status} ${responseText}`);
        }
    }
    if (!response.ok) {
        const serverError = typeof data.error === "string" ? data.error : response.statusText;
        throw new Error(serverError || `Upload failed with status ${response.status}.`);
    }
    const url = typeof data.url === "string" ? data.url : null;
    if (!url) {
        throw new Error("image2url did not return a URL.");
    }
    return {
        url,
        uploadedAt: typeof data.uploadedAt === "string" ? data.uploadedAt : undefined,
    };
}
function buildSnippets(url, alt) {
    return {
        markdown: `![${alt}](${url})`,
        html: `<img src="${url}" alt="${escapeHtml(alt)}" />`,
        bbcode: `[img]${url}[/img]`,
        url,
    };
}
function formatResponse(content, format) {
    const lines = [
        `Direct URL: ${content.url}`,
        ...(format === "all" || format === "markdown"
            ? [`Markdown: ${content.markdown}`]
            : []),
        ...(format === "all" || format === "html"
            ? [`HTML: ${content.html}`]
            : []),
        ...(format === "all" || format === "bbcode"
            ? [`BBCode: ${content.bbcode}`]
            : []),
        `Source: ${content.source} (${content.filename}, ${formatBytes(content.size)}, ${content.mimeType})`,
        `Endpoint: ${content.uploadEndpoint}`,
    ];
    return lines.join("\n");
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function sanitizeBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        return `https://${trimmed}`;
    }
    return trimmed;
}
function normalizePath(pathname) {
    if (!pathname.startsWith("/")) {
        return `/${pathname}`;
    }
    return pathname;
}
function logDebug(...args) {
    if (DEBUG) {
        console.error("[image2url][debug]", ...args);
    }
}
async function start() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`mcp-server-image2url ${VERSION} ready on stdio -> ${UPLOAD_URL} (limit ${formatBytes(MAX_BYTES)})`);
}
start().catch((error) => {
    console.error("Failed to start image2url MCP server:", error);
    process.exit(1);
});
