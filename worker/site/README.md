# SullyOS site on Cloudflare Workers

This Worker serves the Vite `dist/` output through Workers Static Assets and
handles only the same-origin `/api/*` routes that were previously implemented
as Vercel functions.

Cloudflare Workers Builds settings:

- Production branch: `master`
- Build command: `pnpm run build`
- Deploy command: `npx wrangler@4.122.0 deploy`
- Root directory: `/`

Build variables used by Vite:

- `VITE_UMAMI_SCRIPT_URL=https://stats.friedsully.com/script.js`
- `VITE_UMAMI_WEBSITE_ID=3f775277-882d-4453-be2c-3226eddab438`

Optional runtime secrets (`MINIMAX_API_KEY` and `FISH_API_KEY`) are only needed
when the site should provide server-owned fallback API keys. Normal clients
continue to send their own keys in request headers.

The `run_worker_first` rule in `wrangler.jsonc` is deliberately restricted to
`/api/*`. Page, JavaScript, CSS, image, and other static requests bypass the
Worker script and remain static-asset requests.
