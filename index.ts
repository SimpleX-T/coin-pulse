import { Hono } from "hono";
import { ImageResponse } from "@vercel/og";
import { createPublicClient, http, formatEther } from "viem";
import { base } from "viem/chains";
import { request, gql } from "graphql-request";

// Minimal Uniswap V3 Pool ABI for slot0 and liquidity
const UNISWAP_V3_POOL_ABI = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { type: "uint160", name: "sqrtPriceX96" },
      { type: "int24", name: "tick" },
      { type: "uint16", name: "observationIndex" },
      { type: "uint16", name: "observationCardinality" },
      { type: "uint16", name: "observationCardinalityNext" },
      { type: "uint8", name: "feeProtocol" },
      { type: "bool", name: "unlocked" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ type: "uint128", name: "" }],
    stateMutability: "view",
    type: "function",
  },
];

const app = new Hono();

// Configuration
const ZORA_SUBGRAPH_URL = "https://api.zora.co/graphql";
const RPC_URL = "https://rpc.base.org";
const UNISWAP_V3_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory on Base

// Initialize Viem client
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// Initial frame: Prompt for coin symbol
app.get("/", (c) => {
  return c.html(`
    <html>
      <head>
        <meta property="fc:frame" content="vNext" />
        <meta property="fc:frame:image" content="${c.req.url}/welcome-image" />
        <meta property="fc:frame:input:text" content="Enter coin symbol" />
        <meta property="fc:frame:button:1" content="Get Stats" />
        <meta property="fc:frame:post_url" content="${c.req.url}/stats" />
      </head>
    </html>
  `);
});

// Welcome image for initial frame
app.get("/welcome-image", async (c) => {
  const html = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 600px; height: 400px; background: #1a1a1a; color: white; font-family: Arial; font-size: 24px; text-align: center;">
      <h1>CoinPulse</h1>
      <p>Enter a Zora coin symbol to view real-time stats</p>
    </div>
  `;
  return new ImageResponse(html, { width: 600, height: 400 });
});

// Handle stats request
app.post("/stats", async (c) => {
  const body = await c.req.json();
  const symbol = body.untrustedData?.inputText?.trim();
  if (!symbol) {
    return c.html(errorFrame(c.req.url, "No symbol provided"), 400);
  }

  const coinAddress = await getCoinAddressBySymbol(symbol);
  if (!coinAddress) {
    return c.html(errorFrame(c.req.url, `Coin "${symbol}" not found`), 404);
  }

  const imageUrl = `${c.req.url}/image/${encodeURIComponent(symbol)}`;
  return c.html(`
    <html>
      <head>
        <meta property="og:image" content="${imageUrl}" />
        <meta property="fc:frame" content="vNext" />
        <meta property="fc:frame:image" content="${imageUrl}" />
        <meta property="fc:frame:button:1" content="Back" />
        <meta property="fc:frame:post_url" content="${c.req.url}" />
      </head>
    </html>
  `);
});

// Generate stats image
app.get("/image/:symbol", async (c) => {
  const symbol = decodeURIComponent(c.req.param("symbol"));
  const coinAddress = await getCoinAddressBySymbol(symbol);
  if (!coinAddress) {
    return c.text("Coin not found", 404);
  }

  const data = await getCoinData(coinAddress);
  if (!data) {
    return c.text("Error fetching data", 500);
  }

  const formattedData = formatData(symbol, data);
  const html = `
    <div style="display: flex; flex-direction: column; padding: 20px; width: 600px; height: 400px; background: #ffffff; color: #000000; font-family: Arial; font-size: 20px;">
      <h1 style="font-size: 28px; margin-bottom: 10px;">CoinPulse: ${symbol}</h1>
      ${formattedData}
    </div>
  `;
  return new ImageResponse(html, { width: 600, height: 400 });
});

// Resolve coin symbol to address using Zora GraphQL API
async function getCoinAddressBySymbol(symbol: string): Promise<string | null> {
  const query = gql`
    query GetCoinBySymbol($symbol: String!) {
      coins(where: { symbol: $symbol }, first: 1) {
        address
        totalSupply
      }
    }
  `;
  try {
    const data: any = await request(ZORA_SUBGRAPH_URL, query, {
      symbol: symbol.toUpperCase(),
    });
    return data.coins.length > 0 ? data.coins[0].address : null;
  } catch (error) {
    console.error("Error querying subgraph:", error);
    return null;
  }
}

// Fetch coin data using GraphQL and Uniswap V3
async function getCoinData(coinAddress: string) {
  try {
    // Fetch coin metadata from Zora GraphQL
    const coinQuery = gql`
      query GetCoinData($address: String!) {
        coins(where: { address: $address }) {
          totalSupply
          holderCount
        }
      }
    `;
    const coinData: any = await request(ZORA_SUBGRAPH_URL, coinQuery, {
      address: coinAddress.toLowerCase(),
    });

    if (!coinData.coins[0]) return null;
    const totalSupply = Number(coinData.coins[0].totalSupply) / 1e18; // Adjust for 18 decimals
    const holderCount = Number(coinData.coins[0].holderCount) || 0;

    // Fetch Uniswap V3 pool data
    const poolAddress = await getUniswapV3PoolAddress(coinAddress);
    if (!poolAddress) return null;

    // Get price and liquidity
    const [slot0, liquidity] = await Promise.all([
      publicClient.readContract({
        address: `0x${poolAddress}`,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "slot0",
      }) as Promise<any>,
      publicClient.readContract({
        address: `0x${poolAddress}`,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "liquidity",
      }) as Promise<bigint>,
    ]);

    // Calculate price (assuming token0 is WETH, token1 is coin)
    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
    const price = (Number(sqrtPriceX96) ** 2 / 2 ** 192) * 1e18; // Simplified price calculation
    const liquidityEth = Number(formatEther(liquidity)) * price; // Approximate liquidity in ETH

    // Estimate 24h volume (placeholder, as exact volume requires event logs)
    const volume24h = liquidityEth * 0.1; // Placeholder: 10% of liquidity as volume
    const marketCap = price * totalSupply;

    return {
      price,
      volume24h,
      liquidity: liquidityEth,
      holderCount,
      marketCap,
    };
  } catch (error) {
    console.error("Error fetching coin data:", error);
    return null;
  }
}

// Get Uniswap V3 pool address
async function getUniswapV3PoolAddress(
  tokenAddress: string
): Promise<string | null> {
  try {
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH on Base
    const [token0, token1] =
      tokenAddress.toLowerCase() < WETH_ADDRESS.toLowerCase()
        ? [tokenAddress, WETH_ADDRESS]
        : [WETH_ADDRESS, tokenAddress];

    const poolAddress = (await publicClient.readContract({
      address: UNISWAP_V3_FACTORY_ADDRESS,
      abi: [
        {
          inputs: [
            { type: "address", name: "token0" },
            { type: "address", name: "token1" },
            { type: "uint24", name: "fee" },
          ],
          name: "getPool",
          outputs: [{ type: "address" }],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "getPool",
      args: [`0x${token0}`, `0x${token1}`, 3000], // Assume 0.3% fee tier
    })) as string;

    return poolAddress === "0x0000000000000000000000000000000000000000"
      ? null
      : poolAddress;
  } catch (error) {
    console.error("Error fetching pool address:", error);
    return null;
  }
}

// Format data for display
function formatData(symbol: string, data: any): string {
  return `
    <p>Price: $${data.price.toFixed(4)}</p>
    <p>24h Volume: $${data.volume24h.toLocaleString()}</p>
    <p>Liquidity: $${data.liquidity.toLocaleString()}</p>
    <p>Holders: ${data.holderCount.toLocaleString()}</p>
    <p>Market Cap: $${data.marketCap.toLocaleString()}</p>
  `;
}

// Generate error frame HTML
function errorFrame(baseUrl: string, message: string): string {
  const imageUrl = `${baseUrl}/error-image?message=${encodeURIComponent(
    message
  )}`;
  return `
    <html>
      <head>
        <meta property="og:image" content="${imageUrl}" />
        <meta property="fc:frame" content="vNext" />
        <meta property="fc:frame:image" content="${imageUrl}" />
        <meta property="fc:frame:button:1" content="Try Again" />
        <meta property="fc:frame:post_url" content="${baseUrl}" />
      </head>
    </html
  `;
}

// Error image route
app.get("/error-image", async (c) => {
  const message = c.req.query("message") || "Unknown error";
  const html = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 600px; height: 400px; background: #ffcccc; color: #000000; font-family: Arial; font-size: 20px; text-align: center;">
      <h1>Error</h1>
      <p>${message}</p>
    </div>
  `;
  return new ImageResponse(html, { width: 600, height: 400 });
});

export default app;

// https://dark-carrots-fix.loca.lt
