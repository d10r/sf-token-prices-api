# Token Prices API

A simple API for querying Super Token prices

## About

This API provides token prices for Superfluid tokens across different networks. It periodically fetches and caches token prices from the CoinGecko API and serves them via a REST API endpoint.

## API

The API endpoint is:
```
/v1/<network_name>/<token_address>
```
where _network_name_ is the (Superfluid) canonical network name.

This will return the latest known price for the specified token on the given network, along with the timestamp of when the price was last updated.

Example response:
```json
{
  "price": 1234.56,
  "last_updated": "2023-04-01T12:34:56.789Z"
}
```

## Setup

1. Clone the repository
2. Install dependencies:
```bash
yarn install
```
3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```
4. Update the `.env` file with your CoinGecko API key
5. Build the TypeScript code:
```bash
yarn build
```
6. Start the server:
```bash
yarn start
```

## Development

For development with hot reloading:
```bash
yarn dev
```

Set the `DEBUG` environment variable to enable detailed logging:
```bash
DEBUG=true yarn dev
```

## How it works

The API:
1. Periodically fetches token prices from CoinGecko (hourly by default)
2. Maps specific tokens to their prices using information from Superfluid subgraphs
3. Handles native wrappers, ERC20 wrappers, and pure SuperTokens
4. Maintains an in-memory cache of token prices with timestamps
5. Serves the latest known prices via the REST API
