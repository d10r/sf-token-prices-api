import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const UPDATE_INTERVAL_S = parseInt(process.env.UPDATE_INTERVAL || '3600', 10);

// CoinGecko API configuration
const cgBaseUrl = process.env.COINGECKO_BASE_URL || 'https://pro-api.coingecko.com/api/v3';
const cgApiKey = process.env.COINGECKO_API_KEY;

if (!cgApiKey) {
  console.error('COINGECKO_API_KEY is not set in environment variables');
  process.exit(1);
}

// In-memory storage for token prices and their last update timestamps
interface TokenPrice {
  price: number;
  lastUpdated: Date;
}

// Structure: { networkName: { tokenAddress: { price, lastUpdated } } }
const tokenPricesCache: Record<string, Record<string, TokenPrice>> = {};

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Middleware to log every request if DEBUG is set
app.use((req, res, next) => {
  if (process.env.DEBUG) {
    console.log(`[DEBUG] Request: ${req.method} ${req.url} at ${new Date().toISOString()}`);
  }
  next();
});

// API endpoint: /v1/:networkName/:tokenAddress
app.get('/v1/:networkName/:tokenAddress', (req, res) => {
  const { networkName, tokenAddress } = req.params;
  
  // Log the request
  console.log(`Request: GET /v1/${networkName}/${tokenAddress} at ${new Date().toISOString()}`);

  // Check if we have data for this network
  if (!tokenPricesCache[networkName]) {
    return res.status(404).json({ error: `Network ${networkName} not found` });
  }

  // Find the token (case-insensitive)
  const tokenKey = Object.keys(tokenPricesCache[networkName]).find(
    key => key.toLowerCase() === tokenAddress.toLowerCase()
  );

  if (!tokenKey) {
    return res.status(404).json({ error: `Token ${tokenAddress} not found on network ${networkName}` });
  }

  const { price, lastUpdated } = tokenPricesCache[networkName][tokenKey];
  
  res.json({ price, last_updated: lastUpdated });
});

// Start the server
app.listen(port, () => {
  console.log(`Token Prices API listening on port ${port}`);
  
  // Initialize price fetching
  updateAllTokenPrices();
  
  // Set up periodic updates
  setInterval(updateAllTokenPrices, UPDATE_INTERVAL_S * 1000);
});

// Function to fetch listed SuperTokens from a network's subgraph
async function fetchListedSuperTokens(network: { name: string }): Promise<any[]> {
  const subgraph_url = `https://${network.name}.subgraph.x.superfluid.dev`;

  try {
    const response = await axios.post(subgraph_url, {
      query: `
        query {
          tokens(first: 1000, where: { isSuperToken: true, isListed: true, isNativeAssetSuperToken: false }) {
            id
            underlyingAddress
            name
            symbol
          }
        }
      `
    });
    return response.data.data.tokens;
  } catch (error) {
    console.error(`Error fetching tokens for ${network.name}:`, error);
    return [];
  }
}

// Function to fetch token prices from CoinGecko for a specific platform
async function fetchCoingeckoPlatformTokenPrices(
  platform: string, 
  addresses: string[]
): Promise<Record<string, { usd: number }>> {
  if (addresses.length === 0) return {};
  
  const url = `${cgBaseUrl}/simple/token_price/${platform}?contract_addresses=${addresses.join(',')}&vs_currencies=usd`;
  try {
    const response = await axios.get(url, {
      headers: {
        'x-cg-pro-api-key': cgApiKey
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching prices for tokens on ${platform}:`, error);
    return {};
  }
}

// Function to search for native token ID on CoinGecko
async function fetchNativeTokenId(symbol: string): Promise<string | null> {
  // Apply overrides as in the original script
  if (symbol === 'xDAI') {
    symbol = 'DAI';
  } else if (symbol === 'MATIC') {
    symbol = 'POL';
  }

  try {
    const response = await axios.get(`${cgBaseUrl}/search?query=${symbol}`, {
      headers: {
        'x-cg-pro-api-key': cgApiKey
      }
    });
    
    const coin = response.data.coins.find((c: any) => 
      c.symbol.toLowerCase() === symbol.toLowerCase() && 
      c.market_cap_rank // Prefer coins with market cap ranking
    );
    
    return coin?.id || null;
  } catch (error) {
    console.error(`Error searching for native token ${symbol}:`, error);
    return null;
  }
}

// Function to fetch native coin price from CoinGecko
async function fetchNativeCoinPrice(coinId: string): Promise<number | null> {
  const url = `${cgBaseUrl}/simple/price?ids=${coinId}&vs_currencies=usd`;
  try {
    const response = await axios.get(url, {
      headers: {
        'x-cg-pro-api-key': cgApiKey
      }
    });
    return response.data[coinId]?.usd || null;
  } catch (error) {
    console.error(`Error fetching price for native coin ${coinId}:`, error);
    return null;
  }
}

// Main function to update token prices for all networks
async function updateAllTokenPrices() {
  console.log(`Starting token price update at ${new Date().toISOString()}`);
  
  try {
    // Fetch networks from GitHub
    console.log("Fetching networks.json from github");
    const networks_response = await axios.get('https://raw.githubusercontent.com/superfluid-finance/protocol-monorepo/dev/packages/metadata/networks.json');
    const filtered_networks = networks_response.data.filter((network: any) => !network.isTestnet);

    // Fetch coin list from CoinGecko
    console.log("Fetching coinList from coingecko");
    const coinList_response = await axios.get(`${cgBaseUrl}/coins/list?include_platform=true`, {
      headers: {
        'x-cg-pro-api-key': cgApiKey
      }
    });

    let totalTokensProcessed = 0;
    let totalTokensWithPrice = 0;

    // Process each network
    for (const network of filtered_networks) {
      if (!network.coinGeckoId) {
        console.log(`Skipping network ${network.name} - no Coingecko ID found`);
        continue;
      }

      console.log(`Processing network ${network.name} (Coingecko platform: ${network.coinGeckoId})`);
      const tokens = await fetchListedSuperTokens(network);
      
      if (!tokenPricesCache[network.name]) {
        tokenPricesCache[network.name] = {};
      }

      totalTokensProcessed += tokens.length;
      
      // Split tokens into categories
      const nativeTokenWrapper = network.nativeTokenWrapper;

      const pureSuperTokens = tokens.filter(token => 
        token.underlyingAddress === '0x0000000000000000000000000000000000000000'
      );
      
      const wrapperSuperTokens = tokens.filter(token => 
        token.underlyingAddress !== '0x0000000000000000000000000000000000000000' &&
        token.id.toLowerCase() !== network.nativeTokenWrapper?.toLowerCase()
      );

      // Handle native token wrapper
      if (nativeTokenWrapper && network.nativeTokenSymbol) {
        const nativeTokenId = await fetchNativeTokenId(network.nativeTokenSymbol);
        if (nativeTokenId) {
          const price = await fetchNativeCoinPrice(nativeTokenId);
          if (price) {
            // Store with wrapper address
            tokenPricesCache[network.name][nativeTokenWrapper] = {
              price,
              lastUpdated: new Date()
            };
            // Also store with zero address for direct native token queries
            tokenPricesCache[network.name]['0x0000000000000000000000000000000000000000'] = {
              price,
              lastUpdated: new Date()
            };
            totalTokensWithPrice++;
            
            if (process.env.DEBUG) {
              console.log(`  Native token wrapper ${nativeTokenWrapper} (${network.nativeTokenSymbol}x) price: ${price}`);
            }
          }
        }
      }

      // Handle pure super tokens
      if (pureSuperTokens.length > 0) {
        const addresses = pureSuperTokens.map(token => token.id);
        const prices = await fetchCoingeckoPlatformTokenPrices(network.coinGeckoId, addresses);
        
        for (const token of pureSuperTokens) {
          const price = prices[token.id.toLowerCase()]?.usd;
          if (price) {
            tokenPricesCache[network.name][token.id] = {
              price,
              lastUpdated: new Date()
            };
            totalTokensWithPrice++;
            
            if (process.env.DEBUG) {
              console.log(`  Pure super token ${token.id} (${token.symbol}) price: ${price}`);
            }
          }
        }
      }

      // Handle wrapper super tokens
      if (wrapperSuperTokens.length > 0) {
        const addresses = wrapperSuperTokens.map(token => token.underlyingAddress);
        const prices = await fetchCoingeckoPlatformTokenPrices(network.coinGeckoId, addresses);
        
        for (const token of wrapperSuperTokens) {
          const price = prices[token.underlyingAddress.toLowerCase()]?.usd;
          if (price) {
            tokenPricesCache[network.name][token.id] = {
              price,
              lastUpdated: new Date()
            };
            totalTokensWithPrice++;
            
            if (process.env.DEBUG) {
              console.log(`  Wrapper super token ${token.id} (${token.symbol}) price: ${price}`);
            }
          }
        }
      }
    }

    console.log(`Token price update completed at ${new Date().toISOString()}: ${totalTokensWithPrice}/${totalTokensProcessed} tokens updated`);
    
    // Also save to file as backup
    fs.writeFileSync(
      path.join(dataDir, 'token_prices.json'), 
      JSON.stringify(tokenPricesCache, null, 2)
    );
    
  } catch (error) {
    console.error("Error updating token prices:", error);
  }
} 