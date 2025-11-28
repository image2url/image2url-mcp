# mcp-server-image2url

One-command MCP server for image2url.com. Upload a local file or remote image URL and get ready-to-paste snippets (direct URL, Markdown, HTML, BBCode) with zero API keys or accounts.

## One-command setup

Add this to your MCP/Claude config and you are done:

```json
{"command": "npx", "args": ["-y", "mcp-server-image2url"]}
```

Defaults
- Uses `https://www.image2url.com/api/upload` with IP-based free quota.
- No signup, no token required.

## Tool

`upload_image`
- `path` (string, optional): Local image path. Provide either `path` or `url`.
- `url` (string, optional): Remote image URL to fetch and re-upload to image2url.
- `alt` (string, optional): Alt text for generated snippets.
- `format` (enum, optional): `all` (default), `markdown`, `html`, `url`, `bbcode`. Controls which snippets are emphasized in the text response (structured output always contains every format).

Response content
- Direct URL
- Markdown: `![alt](url)`
- HTML: `<img src="url" alt="alt" />`
- BBCode: `[img]url[/img]`
- Source metadata (filename, mime type, size, endpoint)

## Configuration (optional)

Environment variables:
- `IMAGE2URL_BASE_URL`: Base site URL (default `https://www.image2url.com`).
- `IMAGE2URL_UPLOAD_PATH`: Upload path (default `/api/upload`).
- `IMAGE2URL_UPLOAD_URL`: Full upload URL override (skips base/path join).
- `IMAGE2URL_MAX_BYTES`: Max upload size in bytes (default `2097152`, matching the hosted limit).
- `IMAGE2URL_TIMEOUT_MS`: Request timeout in ms (default `20000`).
- `IMAGE2URL_API_TOKEN`: Optional Authorization bearer for private deployments.
- `IMAGE2URL_DEBUG`: Set to `1` to log verbose debug output to stderr.

## Self-hosting

Running your own image2url (Next.js + Cloudflare R2)? Set `IMAGE2URL_BASE_URL` or `IMAGE2URL_UPLOAD_URL` to your deployment. The tool logic and snippet format stay the same.

## Local development

```bash
cd mcp/image2url-mcp
npm install
npm run build
npm start   # runs the stdio MCP server
```

Publish checklist
- `npm run build` to refresh `dist/`
- Ship with the `dist` folder so `npx -y mcp-server-image2url` works with zero setup
