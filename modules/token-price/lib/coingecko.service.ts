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

export class CoingeckoService {
    private readonly baseUrl: string;
    private readonly fiatParam: string;
    private readonly chainId: string;
    private readonly platformId: string;
    private readonly nativeAssetId: string;
    private readonly nativeAssetAddress: string;
    private priceCache: {
        [key: string]: {
            price: Price;
            timestamp: number;
        };
    } = {};
    private readonly CACHE_DURATION = 2 * 60 * 1000; // 2 minutes in milliseconds

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
        const cached = this.priceCache[key];

        // Return cached price if it's less than 2 minutes old
        if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
            return cached.price;
        }

        try {
            // If cache is expired or doesn't exist, fetch new price
            const newPrice = await fetchFn();
            this.priceCache[key] = {
                price: newPrice,
                timestamp: now
            };
            return newPrice;
        } catch (error) {
            // If fetch fails and we have any cached price, return it regardless of age
            if (cached) {
                console.warn(`Using stale cached price for ${key} due to fetch error`);
                return cached.price;
            }
            throw error;
        }
    }

    public async getNativeAssetPrice(): Promise<Price> {
        const cacheKey = `native_${this.nativeAssetId}`;
        return this.getCachedPrice(cacheKey, async () => {
            const response = await this.get<PriceResponse>(
                `/simple/price?ids=${this.nativeAssetId}&vs_currencies=${this.fiatParam}`
            );
            return response[this.nativeAssetId];
        });
    }

    /**
     *  Rate limit for the CoinGecko API is 10 calls each second per IP address.
     */
    public async getTokenPrices(addresses: string[], addressesPerRequest = 1): Promise<TokenPrices> {
        try {
            const results: TokenPrices = {};
            const embrAddress = '0x61c0940b2760C7B64aD8fd775c12D1f11c73deb2';

            // Handle each address individually with caching
            for (const address of addresses) {
                if (address.toLowerCase() === embrAddress.toLowerCase()) {
                    // Handle EMBR price
                    results[address] = await this.getCachedPrice(`token_${address}`, async () => {
                        const embrPrice = parseFloat((await embrService.getProtocolData()).embrPrice);
                        return { usd: embrPrice };
                    });
                } else if (address === this.nativeAssetAddress) {
                    // Handle native asset price
                    results[address] = await this.getNativeAssetPrice();
                } else {
                    // Handle regular token price
                    results[address] = await this.getCachedPrice(`token_${address}`, async () => {
                        const tokenDefinitions = await tokenService.getTokens();
                        const mapped = this.getMappedTokenDetails(address, tokenDefinitions);
                        const endpoint = `/simple/token_price/${mapped.platform}?contract_addresses=${mapped.address}&vs_currencies=${this.fiatParam}`;
                        const response = await this.get<PriceResponse>(endpoint);
                        return response[mapped.address.toLowerCase()];
                    });
                }
            }

            return results;
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
}

export const coingeckoService = new CoingeckoService();
