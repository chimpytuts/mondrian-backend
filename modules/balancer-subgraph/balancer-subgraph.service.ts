import { GraphQLClient } from 'graphql-request';
import {
    Balancer,
    BalancerJoinExitFragment,
    BalancerJoinExitsQueryVariables,
    BalancerLatestPriceFragment,
    BalancerLatestPricesQuery,
    BalancerLatestPricesQueryVariables,
    BalancerPoolFragment,
    BalancerPoolQuery,
    BalancerPoolQueryVariables,
    BalancerPoolSnapshotFragment,
    BalancerPoolSnapshotsQuery,
    BalancerPoolSnapshotsQueryVariables,
    BalancerPoolsQuery,
    BalancerPoolsQueryVariables,
    BalancerPortfolioDataQuery,
    BalancerPortfolioPoolsDataQuery,
    BalancerProtocolDataQueryVariables,
    BalancerTokenPriceFragment,
    BalancerTokenPricesQuery,
    BalancerTokenPricesQueryVariables,
    BalancerTradePairSnapshotsQuery,
    BalancerTradePairSnapshotsQueryVariables,
    BalancerUserFragment,
    BalancerUsersQueryVariables,
    getSdk,
} from './generated/balancer-subgraph-types';
import { env } from '../../app/env';
import _ from 'lodash';
import { subgraphLoadAll, subgraphPurgeCacheKeyAtBlock } from '../util/subgraph-util';
import { Cache, CacheClass } from 'memory-cache';
import { fiveMinutesInMs, fiveMinutesInSeconds, twentyFourHoursInMs } from '../util/time';
import { cache } from '../cache/cache';

const ALL_USERS_CACHE_KEY = 'balance-subgraph_all-users';
const ALL_POOLS_CACHE_KEY = 'balance-subgraph_all-pools';
const ALL_JOIN_EXITS_CACHE_KEY = 'balance-subgraph_all-join-exits';
const PORTFOLIO_POOLS_CACHE_KEY = 'balance-subgraph_portfolio-pools';

export class BalancerSubgraphService {
    private cache: CacheClass<string, any>;
    private readonly client: GraphQLClient;

    constructor() {
        this.cache = new Cache<string, any>();
        this.client = new GraphQLClient(env.BALANCER_SUBGRAPH);
    }

    public async getProtocolData(args: BalancerProtocolDataQueryVariables): Promise<Balancer> {

        try {
            const { balancers } = await this.sdk.BalancerProtocolData(args);

            if (balancers.length === 0) {
                throw new Error('Missing protocol data');
            }


            //There is only ever one
            return balancers[0] as Balancer;
        } catch (e) { 
            console.log(e)
        }

        return {} as Balancer;
    }

    public async getTokenPrices(args: BalancerTokenPricesQueryVariables): Promise<BalancerTokenPricesQuery> {
        return this.sdk.BalancerTokenPrices(args);
    }

    public async getPoolSnapshots(args: BalancerPoolSnapshotsQueryVariables): Promise<BalancerPoolSnapshotsQuery> {
        return this.sdk.BalancerPoolSnapshots(args);
    }

    public async getAllPoolSnapshots(
        args: BalancerPoolSnapshotsQueryVariables,
    ): Promise<BalancerPoolSnapshotFragment[]> {
        return subgraphLoadAll<BalancerPoolSnapshotFragment>(this.sdk.BalancerPoolSnapshots, 'poolSnapshots', args);
    }

    public async getPools(args: BalancerPoolsQueryVariables): Promise<BalancerPoolsQuery> {
        return this.sdk.BalancerPools(args);
    }

    public async getPool(args: BalancerPoolQueryVariables): Promise<BalancerPoolQuery> {
        return this.sdk.BalancerPool(args);
    }

    public async getPortfolioData(id: string, previousBlockNumber: number): Promise<BalancerPortfolioDataQuery> {
        return this.sdk.BalancerPortfolioData({ id, previousBlockNumber });
    }

    public async getAllUsers(args: BalancerUsersQueryVariables): Promise<BalancerUserFragment[]> {
        const users = await subgraphLoadAll<BalancerUserFragment>(this.sdk.BalancerUsers, 'users', args);

        return users.map((user) => this.normalizeBalancerUser(user));
    }

    public async getLatestPrices(args: BalancerLatestPricesQueryVariables): Promise<BalancerLatestPricesQuery> {
        return this.sdk.BalancerLatestPrices(args);
    }

    public async getLatestPrice(id: string): Promise<BalancerLatestPriceFragment | null> {
        const { latestPrice } = await this.sdk.BalancerLatestPrice({ id });

        return latestPrice || null;
    }

    public async getAllTokenPrices(args: BalancerTokenPricesQueryVariables): Promise<BalancerTokenPriceFragment[]> {
        return subgraphLoadAll<BalancerTokenPriceFragment>(this.sdk.BalancerTokenPrices, 'tokenPrices', args);
    }

    public async getAllPools(args: BalancerPoolsQueryVariables): Promise<BalancerPoolFragment[]> {
        return subgraphLoadAll<BalancerPoolFragment>(this.sdk.BalancerPools, 'pools', args);
    }

    public async cachePortfolioPoolsData(previousBlockNumber: number): Promise<BalancerPortfolioPoolsDataQuery> {
        const response = await this.sdk.BalancerPortfolioPoolsData({ previousBlockNumber });

        await cache.putObjectValue(PORTFOLIO_POOLS_CACHE_KEY, response, 5);

        return response;
    }

    public async getPortfolioPoolsData(previousBlockNumber: number): Promise<BalancerPortfolioPoolsDataQuery> {
        const memCached = this.cache.get(PORTFOLIO_POOLS_CACHE_KEY) as BalancerPortfolioPoolsDataQuery | null;

        if (memCached) {
            return memCached;
        }

        const cached = await cache.getObjectValue<BalancerPortfolioPoolsDataQuery>(PORTFOLIO_POOLS_CACHE_KEY);

        if (cached) {
            this.cache.put(PORTFOLIO_POOLS_CACHE_KEY, cached, fiveMinutesInMs);

            return cached;
        }

        return this.cachePortfolioPoolsData(previousBlockNumber);
    }

    public async getAllPoolsAtBlock(block: number): Promise<BalancerPoolFragment[]> {
        const cached = this.cache.get(`${ALL_POOLS_CACHE_KEY}:${block}`) as BalancerPoolFragment[] | null;

        if (cached) {
            return cached;
        }

        const { pools } = await this.sdk.BalancerPools({
            first: 1000,
            where: { totalShares_gt: '0' },
            block: { number: block },
        });

        this.cache.put(`${ALL_POOLS_CACHE_KEY}:${block}`, pools, twentyFourHoursInMs);

        return pools;
    }

    public async getTradePairSnapshots(
        args: BalancerTradePairSnapshotsQueryVariables,
    ): Promise<BalancerTradePairSnapshotsQuery> {
        return this.sdk.BalancerTradePairSnapshots(args);
    }

    public async clearCacheAtBlock(block: number) {
        await subgraphPurgeCacheKeyAtBlock(ALL_USERS_CACHE_KEY, block);
        await subgraphPurgeCacheKeyAtBlock(ALL_POOLS_CACHE_KEY, block);
        await subgraphPurgeCacheKeyAtBlock(ALL_JOIN_EXITS_CACHE_KEY, block);
    }

    public async clearPoolsAtBlock(block: number) {
        await subgraphPurgeCacheKeyAtBlock(ALL_POOLS_CACHE_KEY, block);
    }

    private get sdk() {
        return getSdk(this.client);
    }

    private normalizeBalancerUser(user: BalancerUserFragment): BalancerUserFragment {
        return {
            ...user,
            sharesOwned: user.sharesOwned?.map((shares) => ({
                ...shares,
                //ensure the user balance isn't negative, unsure how the subgraph ever allows this to happen
                balance: parseFloat(shares.balance) < 0 ? '0' : shares.balance,
            })),
        };
    }
}

export const balancerSubgraphService = new BalancerSubgraphService();