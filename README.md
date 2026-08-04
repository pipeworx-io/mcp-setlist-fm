# @pipeworx/setlist-fm

[setlist.fm](https://api.setlist.fm/docs/1.0/) MCP — concert setlists by artist/venue/date. Free API key required.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Setlist Fm data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
