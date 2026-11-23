# Transportli car shipping MCP server

[![Transportli Car Shipping MCP connector – tool definition quality and endpoint health on Glama](https://glama.ai/mcp/connectors/io.github.Transportlicom/car-shipping/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.Transportlicom/car-shipping)

[Model Context Protocol](https://modelcontextprotocol.io) server for the [Transportli car shipping API](https://transportli.com/auto-transport/car-shipping-api/). It lets an AI agent get a **lowest / medium / highest** car shipping price for any US route, create a **real shipping request**, and read the **real carrier bids**.

It is a remote server: you do not run this code to use it. Connect your MCP client to:

```
https://app.transportli.com/mcp
```

(streamable HTTP). For price estimates only, with no API key and a single tool, use `https://app.transportli.com/mcp/estimate` instead. The agent never books or pays anything: for a real request the customer confirms by email first and books a bid themselves.

## Tools

| Tool | What it does | API key |
|---|---|---|
| `estimate_car_shipping` | Lowest, medium and highest total price (US dollars) and road miles for a route and vehicles | not needed |
| `create_shipping_request` | Creates a real request that carriers can bid on; the customer confirms by email first | required |
| `get_quotes` | The real carrier bids, plus the lowest, medium and highest bid so far | required |
| `get_request` | Status, route, estimate and bids of a request | required |
| `cancel_request` | Cancels a request that is not booked yet | required |

## Connect

Estimates work without a key. For the other tools, get an API key (a sandbox key `tl_test_...` never contacts carriers and returns three sample bids): see [how to get one](https://transportli.com/auto-transport/car-shipping-api/#access). Send it as the Bearer token.

Claude Desktop / Cursor style config:

```json
{
  "mcpServers": {
    "transportli": {
      "url": "https://app.transportli.com/mcp",
      "headers": { "Authorization": "Bearer tl_live_..." }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http transportli https://app.transportli.com/mcp --header "Authorization: Bearer tl_live_..."
```

## About the prices

Prices are whole US dollars and are what the customer pays in total (carrier price plus Transportli's security deposit). The price range is an estimate from Transportli's lane data, not a committed price; real prices are the carriers' bids. Transportli is a marketplace: independent, vetted carriers perform the shipments.

## Run it yourself

This repository is the server's source (a thin wrapper over the public REST API). To run your own copy:

```bash
npm install
TL_API_BASE=https://app.transportli.com PORT=3200 npm start   # MCP endpoint: POST /mcp
npm test
```

Stateless streamable HTTP; the caller's API key is forwarded to the API as the Bearer token.

## Links

- API and MCP overview: https://transportli.com/auto-transport/car-shipping-api/
- OpenAPI 3.1 spec: https://app.transportli.com/api/v1/openapi.json
- Postman collection: https://www.postman.com/transportli-1444547/transportli/collection/dveule1/transportli-car-shipping-api
- Open datasets behind the prices (CC BY 4.0): https://huggingface.co/datasets/Transportli/us-car-shipping-prices

MIT licensed.
