interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * setlist.fm MCP.
 */


const BASE = 'https://api.setlist.fm/rest/1.0';
const UA = 'pipeworx-mcp-setlist-fm/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  { name: 'artist', description: 'Artist by MBID.', inputSchema: { type: 'object', properties: { mbid: { type: 'string' } }, required: ['mbid'] } },
  {
    name: 'artist_search',
    description: 'Search artists.',
    inputSchema: { type: 'object', properties: { artistMbid: { type: 'string' }, artistName: { type: 'string' }, artistTmid: { type: 'number' }, sort: { type: 'string' }, p: { type: 'number' } } },
  },
  { name: 'artist_setlists', description: "Artist's setlists.", inputSchema: { type: 'object', properties: { mbid: { type: 'string' }, p: { type: 'number' } }, required: ['mbid'] } },
  { name: 'venue', description: 'Venue detail.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  {
    name: 'venue_search',
    description: 'Search venues.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, cityId: { type: 'string' }, cityName: { type: 'string' }, country: { type: 'string' }, state: { type: 'string' }, stateCode: { type: 'string' }, p: { type: 'number' } } },
  },
  { name: 'venue_setlists', description: 'Setlists at a venue.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, p: { type: 'number' } }, required: ['id'] } },
  { name: 'setlist', description: 'Single setlist.', inputSchema: { type: 'object', properties: { setlist_id: { type: 'string' } }, required: ['setlist_id'] } },
  {
    name: 'setlist_search',
    description: 'Search setlists.',
    inputSchema: {
      type: 'object',
      properties: {
        artistMbid: { type: 'string' },
        artistName: { type: 'string' },
        year: { type: 'number' },
        date: { type: 'string' },
        cityId: { type: 'string' },
        cityName: { type: 'string' },
        country: { type: 'string' },
        state: { type: 'string' },
        stateCode: { type: 'string' },
        tourName: { type: 'string' },
        venueId: { type: 'string' },
        venueName: { type: 'string' },
        p: { type: 'number' },
      },
    },
  },
  { name: 'user', description: 'User profile.', inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] } },
  { name: 'user_attended', description: "User's attended shows.", inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, p: { type: 'number' } }, required: ['user_id'] } },
  { name: 'cities', description: 'City search.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, country: { type: 'string' }, p: { type: 'number' } } } },
  { name: 'countries', description: 'Country list.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) throw new Error('setlist.fm requires an API key. Set PLATFORM_SETLISTFM_KEY or pass ?_apiKey=… (free at https://api.setlist.fm/docs/1.0/index.html#registration).');
  const reqStr = (k: string, ex: string) => {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${k}" is missing. Pass a string like ${ex}.`);
    return v;
  };
  const get = async (path: string, params?: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (k !== '_apiKey' && v != null) p.set(k, String(v));
    const url = `${BASE}${path}${[...p].length ? `?${p}` : ''}`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA, 'x-api-key': apiKey, 'Accept-Language': 'en' } });
    if (res.status === 401 || res.status === 403) throw new Error('setlist.fm: invalid API key.');
    if (!res.ok) throw new Error(`setlist.fm: ${res.status}`);
    return res.json();
  };
  switch (name) {
    case 'artist':
      return get(`/artist/${encodeURIComponent(reqStr('mbid', '"b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d"'))}`);
    case 'artist_search':
      return get('/search/artists', args);
    case 'artist_setlists':
      return get(`/artist/${encodeURIComponent(reqStr('mbid', '"<mbid>"'))}/setlists`, { p: args.p });
    case 'venue':
      return get(`/venue/${encodeURIComponent(reqStr('id', '"<venue_id>"'))}`);
    case 'venue_search':
      return get('/search/venues', args);
    case 'venue_setlists':
      return get(`/venue/${encodeURIComponent(reqStr('id', '"<venue_id>"'))}/setlists`, { p: args.p });
    case 'setlist':
      return get(`/setlist/${encodeURIComponent(reqStr('setlist_id', '"<setlist_id>"'))}`);
    case 'setlist_search':
      return get('/search/setlists', args);
    case 'user':
      return get(`/user/${encodeURIComponent(reqStr('user_id', '"<user_id>"'))}`);
    case 'user_attended':
      return get(`/user/${encodeURIComponent(reqStr('user_id', '"<user_id>"'))}/attended`, { p: args.p });
    case 'cities':
      return get('/search/cities', args);
    case 'countries':
      return get('/search/countries');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
