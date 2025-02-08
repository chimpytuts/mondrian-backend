import axios from 'axios';
import { twentyFourHoursInSecs } from '../../util/time';
import _ from 'lodash';
import { env } from '../../../app/env';
import { HistoricalPrice, HistoricalPriceResponse, Price, PriceResponse, TokenPrices } from '../token-price-types';
import moment from 'moment-timezone';
import { tokenService } from '../../token/token.service';
import { TokenDefinition } from '../../token/token-types';
import { getAddress, isAddress } from 'ethers/lib/utils';
import { embrService } from '../../embr/embr.service';

interface MappedToken {
    platform: string;
    address: string;
    originalAddress?: string;
}

interface DexScreenerResponse {
    schemaVersion: string;
    pairs: {
        priceUsd: string;
        liquidity: {
            usd: number;
        };
    }[];
    pair: {
        priceUsd: string;
        liquidity: {
            usd: number;
        };
    };
}

interface DexScreenerTokenPairsResponse {
    schemaVersion: string;
    pairs?: {
        priceUsd: string;
        liquidity: {
            usd: number;
        };
    }[];
}

interface DexScreenerPair {
    priceUsd: string;
    liquidity: {
        usd: number;
    };
    baseToken: {
        address: string;
    };
}

export class CoingeckoService {
    private readonly baseUrl: string;
    private readonly fiatParam: string;
    private readonly chainId: string;
    private readonly platformId: string;
    private readonly nativeAssetId: string;
    private readonly nativeAssetAddress: string;
    private tokenPricesCache: {
        prices: { [address: string]: { price: Price; timestamp: number } };
        lastUpdate: number;
    } = { 
        prices: {},
        lastUpdate: 0
    };
    private readonly CACHE_DURATION = 2 * 60 * 1000; // 2 minutes in milliseconds
    private readonly RATE_LIMIT_DURATION = 60 * 1000; // 1 minute in milliseconds

    private readonly NATIVE_PAIR_ADDRESS = '0x22E77FfE8d3ee3a161f657F235807caF891F5638';

    constructor() {
        this.baseUrl = 'https://api.coingecko.com/api/v3';
        this.fiatParam = 'usd';
        this.chainId = env.CHAIN_ID;
        this.platformId = env.COINGECKO_PLATFORM_ID;
        this.nativeAssetId = env.COINGECKO_NATIVE_ASSET_ID;
        this.nativeAssetAddress = env.NATIVE_ASSET_ADDRESS;
    }

    private async getCachedPrice(key: string, fetchFn: () => Promise<Price>): Promise<Price> {
        const now = Date.now();
        const cached = this.tokenPricesCache.prices[key];

        if (cached) {
            const cacheAge = now - cached.timestamp;
            const isRateLimited = now - this.tokenPricesCache.lastUpdate < this.RATE_LIMIT_DURATION;
            
            if (cacheAge < this.CACHE_DURATION || isRateLimited) {
                return cached.price;
            }
        }

        try {
            const newPrice = await fetchFn();
            this.tokenPricesCache.prices[key] = {
                price: newPrice,
                timestamp: now
            };
            this.tokenPricesCache.lastUpdate = now;
            return newPrice;
        } catch (error: any) {
            if (cached) {
                const errorMessage = error.message || 'Unknown error';
                console.warn(`Using cached price for ${key} due to error:`, errorMessage);
                return cached.price;
            }
            throw error;
        }
    }

    private async fetchFreshTokenPrices(addresses: string[]): Promise<TokenPrices> {
        const results: TokenPrices = {};
        const embrAddress = '0x61c0940b2760C7B64aD8fd775c12D1f11c73deb2';
        const specialTokens = {
            '0x7f7a85ed620053259f886749600e73e90aefc84b': '0x3a101be3665af38b617908d9dc9029ce27fe31e9', // MOIST
            '0x84a71ccd554cc1b02749b35d22f684cc8ec987e1': '0xdfcdad314b0b96ab8890391e3f0540278e3b80f7', // MOIST
            '0x01440f9b32c52aeffd957c155ff2454ff0138849': '0xa059905a7d620202cbc8e743e9f21ebd4bc3af34', //SURV

        };

        for (const address of addresses) {
            try {
                const addressLower = address.toLowerCase();

                if (specialTokens[addressLower]) {
                    results[address] = await this.getCachedPrice(`dexscreener_special_${addressLower}`, async () => {
                        const { data } = await axios.get<DexScreenerResponse>(
                            `https://api.dexscreener.com/latest/dex/pairs/sonic/${specialTokens[addressLower]}`
                        );
                        if(address === '0x01440f9b32c52aeffd957c155ff2454ff0138849') {
                            console.log(`DexScreener response for ${address}:`, data);
                            return { usd: parseFloat(data.pair.priceUsd) };
                        }
                        return { usd: parseFloat(data.pair.priceUsd) };
                    });


                } else if (addressLower === embrAddress.toLowerCase()) {
                    results[address] = await this.getCachedPrice(`embr_${addressLower}`, async () => {
                        const embrPrice = parseFloat((await embrService.getProtocolData()).embrPrice);
                        return { usd: embrPrice };
                    });
                } else if (address === this.nativeAssetAddress) {
                    results[address] = await this.getCachedPrice(`native_${addressLower}`, async () => {
                        const { data } = await axios.get<DexScreenerResponse>(
                            `https://api.dexscreener.com/latest/dex/pairs/abstract/${this.NATIVE_PAIR_ADDRESS}`
                        );
                        return { usd: parseFloat(data.pair.priceUsd) };
                    });
                } else {
                    // For all other tokens, use DexScreener token-pairs API
                    results[address] = await this.getCachedPrice(`token_${addressLower}`, async () => {
                        try {
                            const response = await axios.get(
                                `https://api.dexscreener.com/token-pairs/v1/abstract/${address}`
                            );
                            
                            console.log(`DexScreener response for ${address}:`, JSON.stringify(response.data, null, 2));

                            const pairs = response.data as DexScreenerPair[];

                            // Check if pairs exist and is an array
                            if (!Array.isArray(pairs)) {
                                throw new Error(`Invalid response format for token ${address}`);
                            }

                            // Filter out pairs with invalid or zero liquidity
                            // Also ensure we're looking at pairs where our token is the base token
                            const validPairs = pairs.filter(pair => 
                                pair && 
                                pair.priceUsd && 
                                pair.liquidity?.usd && 
                                pair.liquidity.usd > 0 &&
                                !isNaN(parseFloat(pair.priceUsd)) &&
                                pair.baseToken?.address?.toLowerCase() === address.toLowerCase()
                            );

                            if (!validPairs.length) {
                                throw new Error(`No valid pairs found for token ${address}`);
                            }

                            // Sort by liquidity
                            const sortedPairs = validPairs.sort((a, b) => 
                                (b.liquidity.usd) - (a.liquidity.usd)
                            );

                            return { usd: parseFloat(sortedPairs[0].priceUsd) };
                        } catch (error: any) {
                            console.error(`Detailed error for ${address}:`, {
                                message: error.message,
                                response: error.response?.data
                            });
                            throw error;
                        }
                    });
                }
            } catch (error) {
                console.error(`Error fetching price for address ${address}:`, error);
                continue;
            }
        }

        return results;
    }

    public async getTokenPrices(addresses: string[]): Promise<TokenPrices> {
        try {
            return await this.fetchFreshTokenPrices(addresses);
        } catch (error) {
            console.error('Unable to fetch token prices', addresses, error);
            throw error;
        }
    }

    public async getTokenHistoricalPrices(address: string, days: number): Promise<HistoricalPrice[]> {
        const now = Math.floor(Date.now() / 1000);
        const end = now;
        const start = end - days * twentyFourHoursInSecs;

        const tokenDefinitions = await tokenService.getTokens();
        const mapped = this.getMappedTokenDetails(address, tokenDefinitions);
        
        const endpoint = `/coins/${mapped.platform}/contract/${mapped.address}/market_chart/range?vs_currency=${this.fiatParam}&from=${start}&to=${end}`;

        const result = await this.get<HistoricalPriceResponse>(endpoint);

        return result.prices.map((item) => ({
            //anchor to the start of the hour
            timestamp:
                moment
                    .unix(item[0] / 1000)
                    .startOf('hour')
                    .unix() * 1000,
            price: item[1],
        }));
    }

    private parsePaginatedTokens(paginatedResults: TokenPrices[], mappedTokens: MappedToken[]): TokenPrices {
        const results = paginatedResults.reduce((result, page) => ({ ...result, ...page }), {});
        const prices: TokenPrices = _.mapKeys(results, (val, address) => this.getAddress(address));

        for (const mappedToken of mappedTokens) {
            if (mappedToken.originalAddress && results[mappedToken.address]) {
                prices[this.getAddress(mappedToken.originalAddress)] = results[mappedToken.address];
            }
        }

        return prices;
    }

    /**
     * Support instances where a token address is not supported by the platform id, provide the option to use a different platform
     */
    public getMappedTokenDetails(address: string, tokens: TokenDefinition[]): MappedToken {
        const token = tokens.find((token) => token.address.toLowerCase() === address.toLowerCase());
        if (token && token.coingeckoPlatformId && token.coingeckoContractAddress) {
            return {
                platform: token.coingeckoPlatformId,
                address: isAddress(token.coingeckoContractAddress)
                    ? token.coingeckoContractAddress.toLowerCase()
                    : token.coingeckoContractAddress,
                originalAddress: address.toLowerCase(),
            };
        }

        return {
            platform: this.platformId,
            address: address.toLowerCase(),
        };
    }

    private getAddress(address: string) {
        return isAddress(address) ? getAddress(address) : address;
    }

    private async get<T>(endpoint: string): Promise<T> {
        const { data } = await axios.get(this.baseUrl + endpoint);
        return data;
    }

    public async getNativeAssetPrice(): Promise<Price> {
        try {
            const cached = this.tokenPricesCache.prices[`native_${this.nativeAssetAddress.toLowerCase()}`];
            const now = Date.now();

            if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
                return cached.price;
            }

            const { data } = await axios.get<DexScreenerResponse>(
                `https://api.dexscreener.com/latest/dex/pairs/abstract/${this.NATIVE_PAIR_ADDRESS}`
            );

            const price: Price = { usd: parseFloat(data.pair.priceUsd) };
            
            // Cache the result
            this.tokenPricesCache.prices[`native_${this.nativeAssetAddress.toLowerCase()}`] = {
                price,
                timestamp: now
            };

            return price;
        } catch (error: any) {
            console.error('Error fetching native asset price:', error.message);
            
            // Return cached price if available, even if expired
            const cached = this.tokenPricesCache.prices[`native_${this.nativeAssetAddress.toLowerCase()}`];
            if (cached) {
                return cached.price;
            }
            
            throw error;
        }
    }
}

export const coingeckoService = new CoingeckoService();
