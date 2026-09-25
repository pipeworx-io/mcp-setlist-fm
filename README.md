# @pipeworx/setlist-fm

[setlist.fm](https://api.setlist.fm/docs/1.0/) MCP — concert setlists by artist/venue/date. Free API key required.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Auth

- Platform: `PLATFORM_SETLISTFM_KEY`. BYO: `?_apiKey=…`.

## Tools

- `artist(mbid)` — artist by MusicBrainz ID
- `artist_search(artistMbid?, artistName?, artistTmid?, sort?, p?)` — search artists
- `artist_setlists(mbid, p?)` — setlists for an artist
- `venue(id)` — venue detail
- `venue_search(name?, cityId?, cityName?, country?, state?, stateCode?, p?)` — search venues
- `venue_setlists(id, p?)` — setlists at a venue
- `setlist(setlist_id)` — single setlist
- `setlist_search(artistMbid?, artistName?, year?, date?, cityId?, cityName?, country?, state?, stateCode?, tourName?, venueId?, venueName?, p?)` — search setlists
- `user(user_id)` — user profile
- `user_attended(user_id, p?)` — user's attended shows
- `cities(name?, country?, p?)` — city search
- `countries()` — country list

## Data source

`https://api.setlist.fm/rest/1.0`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "setlist-fm": {
      "url": "https://gateway.pipeworx.io/setlist-fm/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/setlist-fm/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/setlist_fm_artist \
  -H 'Content-Type: application/json' \
  -d '{"mbid":"79239b12-edad-4280-a524-8344d868a69e"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/setlist_fm_artist`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "setlist-fm": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-setlist-fm"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-setlist-fm
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Setlist Fm data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
