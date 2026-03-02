import { createMultichainClient, type Scope } from "@metamask/connect-multichain";
import { getErrorAnalyticsProperties } from "@toruslabs/base-controllers";
import { JRPCResponse } from "@toruslabs/constants";
import { JRPCRequest, Maybe, RequestArguments, SendCallBack } from "@web3auth/auth";

import {
  type Analytics,
  ANALYTICS_EVENTS,
  BaseConnectorLoginParams,
  type BaseConnectorSettings,
  CHAIN_NAMESPACES,
  type ChainNamespaceType,
  CONNECTED_EVENT_DATA,
  CONNECTOR_CATEGORY,
  type CONNECTOR_CATEGORY_TYPE,
  CONNECTOR_EVENTS,
  CONNECTOR_NAMESPACES,
  CONNECTOR_STATUS,
  type CONNECTOR_STATUS_TYPE,
  type ConnectorFn,
  type ConnectorInitOptions,
  type ConnectorNamespaceType,
  type ConnectorParams,
  getCaipChainId,
  IdentityTokenInfo,
  type IProvider,
  ProviderEvents,
  SOLANA_CAIP_CHAIN_MAP,
  type UserInfo,
  WALLET_CONNECTOR_TYPE,
  WALLET_CONNECTORS,
  WalletLoginError,
  Web3AuthError,
} from "../../base";
import { BaseEvmConnector } from "../base-evm-connector";
import { getSiteName } from "../utils";

type LegacyProviderMethods = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send?: (req: JRPCRequest<any>, callback: SendCallBack<JRPCResponse<any>>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: (req: JRPCRequest<any>) => Promise<JRPCResponse<any>>;
};

/**
 * Configuration options for the MetaMask connector using @metamask/connect-multichain
 */
export interface MetaMaskConnectorSettings {
  /** Dapp identification and branding settings */
  dapp?: {
    name?: string;
    url?: string;
    iconUrl?: string;
  };
  /** Enable debug logging for the MetaMask SDK */
  debug?: boolean;
  /** UI options */
  ui?: {
    /** Prefer browser extension over mobile QR */
    preferExtension?: boolean;
    /** Show modal to install extension */
    showInstallModal?: boolean;
    /** Set true for custom QR UI */
    headless?: boolean;
  };
}

class WrappedProvider implements IProvider {
  private instance: Awaited<ReturnType<typeof createMultichainClient>>;

  constructor(instance: Awaited<ReturnType<typeof createMultichainClient>>) {
    this.instance = instance;
  }
  addListener<E extends keyof ProviderEvents>(_event: E, _listener: ProviderEvents[E]): this {
    throw new Error("Method not implemented.");
  }
  prependListener<E extends keyof ProviderEvents>(_event: E, _listener: ProviderEvents[E]): this {
    throw new Error("Method not implemented.");
  }
  prependOnceListener<E extends keyof ProviderEvents>(_event: E, _listener: ProviderEvents[E]): this {
    throw new Error("Method not implemented.");
  }
  removeAllListeners<E extends keyof ProviderEvents>(_event?: E): this {
    throw new Error("Method not implemented.");
  }
  eventNames(): (string | symbol)[] {
    throw new Error("Method not implemented.");
  }
  rawListeners<E extends keyof ProviderEvents>(_event: E): ProviderEvents[E][] {
    throw new Error("Method not implemented.");
  }
  listeners<E extends keyof ProviderEvents>(_event: E): ProviderEvents[E][] {
    throw new Error("Method not implemented.");
  }
  listenerCount<E extends keyof ProviderEvents>(_event: E): number {
    throw new Error("Method not implemented.");
  }
  getMaxListeners(): number {
    throw new Error("Method not implemented.");
  }
  setMaxListeners(_: number): this {
    throw new Error("Method not implemented.");
  }

  get chainId(): string {
    // Try to get chainId from the underlying provider if available
    return "0x1";
  }

  // IProvider requires these functions:
  async request<S, R>(args: RequestArguments<S>): Promise<Maybe<R>> {
    if (!this.instance) {
      throw WalletLoginError.notConnectedError("MetaMask provider is not available");
    }
    return this.instance.invokeMethod({ scope: "eip155:1", request: { method: args.method, params: args.params } }) as Promise<Maybe<R>>;
  }

  sendAsync<T, U>(req: JRPCRequest<T>, callback: SendCallBack<JRPCResponse<U>>): void;
  sendAsync<T, U>(req: JRPCRequest<T>): Promise<JRPCResponse<U>>;
  sendAsync<T, U>(req: JRPCRequest<T>, callback?: SendCallBack<JRPCResponse<U>>): void | Promise<JRPCResponse<U>> {
    if (!this.instance.provider) {
      const err = WalletLoginError.notConnectedError("MetaMask provider is not available");
      if (callback) {
        callback(err, null);
        return;
      } else {
        return Promise.reject(err);
      }
    }
    // use compatible provider method
    const provider = this.instance.provider as unknown as LegacyProviderMethods;
    if (callback) {
      return provider.send?.(req, callback);
    }
    return provider.request(req) as Promise<JRPCResponse<U>>;
  }

  send<T, U>(req: JRPCRequest<T>, callback: SendCallBack<JRPCResponse<U>>): void {
    if (!this.instance.provider) {
      callback(WalletLoginError.notConnectedError("MetaMask provider is not available"), null);
      return;
    }
    (this.instance.provider as unknown as LegacyProviderMethods).send?.(req, callback);
  }

  // For event handling, delegate to provider if available
  on(event: keyof ProviderEvents, listener: (...args: unknown[]) => void): this {
    this.instance.on(event, listener);
    return this;
  }

  once(event: keyof ProviderEvents, listener: (...args: unknown[]) => void): this {
    this.instance.once(event, listener);
    return this;
  }

  off(event: keyof ProviderEvents, listener: (...args: unknown[]) => void): this {
    this.instance.off(event, listener);
    return this;
  }

  removeListener(event: keyof ProviderEvents, listener: (...args: unknown[]) => void): this {
    this.instance.removeListener(event, listener);
    return this;
  }

  // Optionally for compatibility (SafeEventEmitter)
  emit(event: keyof ProviderEvents, ...args: unknown[]): boolean {
    this.instance.emit?.(event, args[0]);
    return false;
  }
}

export interface MetaMaskConnectorOptions extends BaseConnectorSettings {
  connectorSettings?: MetaMaskConnectorSettings;
}

class MetaMaskConnector extends BaseEvmConnector<void> {
  readonly connectorNamespace: ConnectorNamespaceType = CONNECTOR_NAMESPACES.MULTICHAIN;

  readonly currentChainNamespace: ChainNamespaceType = CHAIN_NAMESPACES.OTHER;

  readonly type: CONNECTOR_CATEGORY_TYPE = CONNECTOR_CATEGORY.EXTERNAL;

  readonly name: WALLET_CONNECTOR_TYPE = WALLET_CONNECTORS.METAMASK;

  public status: CONNECTOR_STATUS_TYPE = CONNECTOR_STATUS.NOT_READY;

  private metamaskProvider: IProvider | null = null;

  private metamaskInstance: Awaited<ReturnType<typeof createMultichainClient>> | null = null;

  private metamaskPromise: ReturnType<typeof createMultichainClient> | undefined;

  private connectorSettings?: MetaMaskConnectorSettings;

  private analytics?: Analytics;

  constructor(connectorOptions: MetaMaskConnectorOptions) {
    super(connectorOptions);
    this.connectorSettings = connectorOptions.connectorSettings;
    this.analytics = connectorOptions.analytics;
  }

  get provider(): IProvider | null {
    if (this.status !== CONNECTOR_STATUS.NOT_READY && this.metamaskProvider) {
      const wrappedProvider = new WrappedProvider(this.metamaskInstance);
      return wrappedProvider;
      // return this.metamaskProvider as unknown as IProvider;
    }
    return null;
  }

  set provider(_: IProvider | null) {
    throw new Error("Not implemented");
  }

  /**
   * Ensures the MetaMask Connect Multichain instance is initialized
   */
  private async ensureMetamask(): Promise<Awaited<ReturnType<typeof createMultichainClient>>> {
    if (!this.metamaskInstance) {
      if (!this.metamaskPromise) {
        throw WalletLoginError.notConnectedError("Connector is not initialized. Call init() first.");
      }
      this.metamaskInstance = await this.metamaskPromise;
    }
    return this.metamaskInstance;
  }

  /**
   * Sets up event listeners on the MetaMask instance
   */
  private setupEventListeners(instance: Awaited<ReturnType<typeof createMultichainClient>>): void {
    instance.on("wallet_sessionChanged", (_session: unknown) => {
      // Session changed - could handle account/chain updates here
    });

    instance.on("stateChanged", async (status: unknown) => {
      if (status === "connecting") {
        if (this.status !== CONNECTOR_STATUS.CONNECTING) {
          this.status = CONNECTOR_STATUS.CONNECTING;
          this.emit(CONNECTOR_EVENTS.CONNECTING, { connector: WALLET_CONNECTORS.METAMASK });
        }
      } else if (status === "connected") {
        if (this.status !== CONNECTOR_STATUS.CONNECTED) {
          this.status = CONNECTOR_STATUS.CONNECTED;
          const provider = instance.provider as unknown as IProvider;
          // awkward, need 1193 provider here
          if (provider) {
            this.metamaskProvider = provider;
            const wrappedProvider = new WrappedProvider(instance);

            let identityTokenInfo: IdentityTokenInfo | undefined;
            if (this.getIdentityToken) {
              identityTokenInfo = await this.getIdentityToken();
            }
            this.emit(CONNECTOR_EVENTS.CONNECTED, {
              connector: WALLET_CONNECTORS.METAMASK,
              reconnected: this.rehydrated,
              provider: wrappedProvider,
              identityTokenInfo,
            });
          }
        }
      } else if (status === "disconnected") {
        this.disconnect().catch(() => {
          // Ignore disconnect errors
        });
      }
    });

    // Listen for QR code URI to display (for mobile wallet connection)
    instance.on("display_uri", (uri: unknown) => {
      if (typeof uri === "string" && uri) {
        this.updateConnectorData({ uri });
      }
    });
  }

  /**
   * Converts chain config to CAIP-2 scope format
   */
  private getChainScope(chainId: string, chainNamespace: ChainNamespaceType): Scope {
    if (chainNamespace === CHAIN_NAMESPACES.SOLANA) {
      const solanaChainId = SOLANA_CAIP_CHAIN_MAP[chainId];
      if (solanaChainId) {
        return `solana:${solanaChainId}` as Scope;
      }
    }
    // Default to EIP155 format
    const numericChainId = parseInt(chainId, 16);
    return `eip155:${numericChainId}` as Scope;
  }

  async init(options: ConnectorInitOptions): Promise<void> {
    await super.init(options);
    const chainConfig = this.coreOptions.chains.find((x) => x.chainId === options.chainId);
    super.checkInitializationRequirements({ chainConfig });

    // Build supported networks in CAIP-2 format (scope -> rpcUrl)
    const supportedNetworks: Record<string, string> = {};
    for (const chain of this.coreOptions.chains) {
      const scope = this.getChainScope(chain.chainId, chain.chainNamespace);
      supportedNetworks[scope] = chain.rpcTarget;
    }

    // Add fallback public RPC endpoints
    const defaultNetworks: Record<string, string> = {
      "eip155:1": "https://mainnet.infura.io/v3/de3198afe5f44ee99d155c9843001539",
      "eip155:5": "https://goerli.infura.io/v3/demo",
      "eip155:11155111": "https://sepolia.infura.io/v3/demo",
      "eip155:137": "https://polygon-rpc.com",
    };

    // Detect app metadata
    const appName = getSiteName(window) || this.connectorSettings?.dapp?.name || "web3auth";
    const appUrl = this.connectorSettings?.dapp?.url || window.location.origin || "https://web3auth.io";
    const appIconUrl = this.connectorSettings?.dapp?.iconUrl;

    // Initialize the MetaMask Connect Multichain SDK
    this.metamaskPromise = createMultichainClient({
      dapp: {
        name: appName,
        url: appUrl,
        ...(appIconUrl && { iconUrl: appIconUrl }),
      },
      api: {
        supportedNetworks: {
          ...defaultNetworks,
          ...supportedNetworks,
        },
      },
      ui: {
        preferExtension: this.connectorSettings?.ui?.preferExtension ?? true,
        showInstallModal: this.connectorSettings?.ui?.showInstallModal,
        headless: this.connectorSettings?.ui?.headless,
      },
      debug: this.connectorSettings?.debug,
    });

    try {
      this.metamaskInstance = await this.metamaskPromise;
      this.setupEventListeners(this.metamaskInstance);
    } catch (error) {
      throw WalletLoginError.connectionError("Failed to initialize MetaMask Connect SDK", error);
    }

    // TODO need to figure this out
    this.isInjected = false;

    if (this.metamaskInstance.status === "connected") {
      this.status = CONNECTOR_STATUS.CONNECTED;
      let identityTokenInfo: IdentityTokenInfo | undefined;

      if (options.getIdentityToken) {
        identityTokenInfo = await this.getIdentityToken();
      }
      this.rehydrated = true;

      const provider = this.metamaskInstance.provider as unknown as IProvider;
      if (!provider) throw WalletLoginError.notConnectedError("Failed to connect with provider");

      this.metamaskProvider = provider;
      const wrappedProvider = new WrappedProvider(this.metamaskInstance);

      this.emit(CONNECTOR_EVENTS.CONNECTED, {
        connector: WALLET_CONNECTORS.METAMASK,
        reconnected: this.rehydrated,
        provider: wrappedProvider,
        identityTokenInfo,
      } as CONNECTED_EVENT_DATA);
    } else if (this.metamaskInstance.status === "loaded") {
      this.status = CONNECTOR_STATUS.READY;
      this.emit(CONNECTOR_EVENTS.READY, WALLET_CONNECTORS.METAMASK);
    } else if (this.metamaskInstance.status === "pending") {
      // 'pending' implies that a transport failed to resume the connection
      this.status = CONNECTOR_STATUS.READY;
      this.emit(CONNECTOR_EVENTS.READY, WALLET_CONNECTORS.METAMASK);
    } else {
      // 'connecting' is not a possible state at this point
      // 'disconnected' is not a possible state at this point
      // Something unexpected happened
      this.status = CONNECTOR_STATUS.ERRORED;
      this.emit(CONNECTOR_EVENTS.ERRORED, new Error("Failed to initialize MetaMask Connect.") as Web3AuthError);
    }
  }

  async connect({ chainId, getIdentityToken }: BaseConnectorLoginParams): Promise<IProvider | null> {
    super.checkConnectionRequirements();

    const instance = await this.ensureMetamask();

    const chainConfig = this.coreOptions.chains.find((x) => x.chainId === chainId);
    if (!chainConfig) throw WalletLoginError.connectionError("Chain config is not available");

    // Convert chains to CAIP-2 scopes for the multichain SDK
    const scopes = this.coreOptions.chains.map((c) => this.getChainScope(c.chainId, c.chainNamespace));

    // Skip tracking for rehydration since only new connections are tracked
    const shouldTrack = !this.rehydrated;
    const startTime = Date.now();
    const eventData = {
      connector: this.name,
      connector_type: this.type,
      is_injected: this.isInjected,
      chain_id: getCaipChainId(chainConfig),
      chain_name: chainConfig?.displayName,
      chain_namespace: chainConfig?.chainNamespace,
    };

    try {
      if (this.status !== CONNECTOR_STATUS.CONNECTING) {
        this.status = CONNECTOR_STATUS.CONNECTING;
        this.emit(CONNECTOR_EVENTS.CONNECTING, { connector: WALLET_CONNECTORS.METAMASK });

        // Connect using the multichain SDK with CAIP-2 scopes
        await instance.connect(scopes, []);
      }

      // Get the provider from the SDK
      const provider = instance.provider as unknown as IProvider;
      if (!provider) throw WalletLoginError.notConnectedError("Failed to connect with provider");

      this.metamaskProvider = provider;

      this.status = CONNECTOR_STATUS.CONNECTED;

      // Track connection events
      if (shouldTrack) {
        this.analytics?.track(ANALYTICS_EVENTS.CONNECTION_STARTED, eventData);
        this.analytics?.track(ANALYTICS_EVENTS.CONNECTION_COMPLETED, {
          ...eventData,
          duration: Date.now() - startTime,
        });
      }

      let identityTokenInfo: IdentityTokenInfo | undefined;

      const wrappedProvider = new WrappedProvider(this.metamaskInstance);

      this.emit(CONNECTOR_EVENTS.CONNECTED, {
        connector: WALLET_CONNECTORS.METAMASK,
        reconnected: this.rehydrated,
        provider: wrappedProvider,
        identityTokenInfo,
      } as CONNECTED_EVENT_DATA);

      if (getIdentityToken) {
        identityTokenInfo = await this.getIdentityToken();
      }

      return this.metamaskProvider;
    } catch (error) {
      // Ready again to be connected
      this.status = CONNECTOR_STATUS.READY;
      if (!this.rehydrated) this.emit(CONNECTOR_EVENTS.ERRORED, error as Web3AuthError);
      this.rehydrated = false;

      // Track connection events
      if (shouldTrack) {
        this.analytics?.track(ANALYTICS_EVENTS.CONNECTION_STARTED, eventData);
        this.analytics?.track(ANALYTICS_EVENTS.CONNECTION_FAILED, {
          ...eventData,
          ...getErrorAnalyticsProperties(error),
          duration: Date.now() - startTime,
        });
      }
      if (error instanceof Web3AuthError) throw error;
      throw WalletLoginError.connectionError("Failed to login with MetaMask wallet", error);
    }
  }

  async disconnect(options: { cleanup: boolean } = { cleanup: false }): Promise<void> {
    if (!this.metamaskInstance) throw WalletLoginError.connectionError("MetaMask instance is not available");
    await super.disconnectSession();

    // Disconnect using the new SDK
    await this.metamaskInstance.disconnect();

    if (options.cleanup) {
      this.status = CONNECTOR_STATUS.NOT_READY;
      this.metamaskProvider = null;
      this.metamaskInstance = null;
      this.metamaskPromise = undefined;
    } else {
      // Ready to be connected again
      this.status = CONNECTOR_STATUS.READY;
    }
    await super.disconnect();
  }

  async getUserInfo(): Promise<Partial<UserInfo>> {
    if (!this.canAuthorize) throw WalletLoginError.notConnectedError("Not connected with wallet, Please login/connect first");
    return {};
  }

  public async switchChain(params: { chainId: string }, init = false): Promise<void> {
    super.checkSwitchChainRequirements(params, init);

    const instance = await this.ensureMetamask();

    const chainConfig = this.coreOptions.chains.find((x) => x.chainId === params.chainId);
    if (!chainConfig) throw WalletLoginError.connectionError("Chain config is not available");

    const targetScope = this.getChainScope(params.chainId, chainConfig.chainNamespace);

    // For EVM chains, use wallet_switchEthereumChain via invokeMethod
    if (chainConfig.chainNamespace === CHAIN_NAMESPACES.EIP155) {
      try {
        await instance.invokeMethod({ // TODO: need to use the evm provider here...
          scope: targetScope,
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: params.chainId }],
          },
        });
      } catch (error: unknown) {
        // If chain doesn't exist, try to add it first
        if ((error as { code?: number })?.code === 4902) {
          await instance.invokeMethod({ // TODO: need to use the evm provider here...
            scope: targetScope,
            request: {
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: params.chainId,
                  chainName: chainConfig.displayName,
                  rpcUrls: [chainConfig.rpcTarget],
                  blockExplorerUrls: chainConfig.blockExplorerUrl ? [chainConfig.blockExplorerUrl] : undefined,
                  nativeCurrency: {
                    name: chainConfig.tickerName,
                    symbol: chainConfig.ticker,
                    decimals: chainConfig.decimals || 18,
                  },
                  iconUrls: chainConfig.logo ? [chainConfig.logo] : undefined,
                },
              ],
            },
          });
        } else {
          throw error;
        }
      }
    }
    // For Solana and other non-EVM chains, chain switching is handled by targeting the appropriate scope
    // The multichain API allows invoking methods on any connected scope
  }

  public async enableMFA(): Promise<void> {
    throw new Error("Method Not implemented");
  }

  public async manageMFA(): Promise<void> {
    throw new Error("Method Not implemented");
  }
}

/**
 * Factory function to create a MetaMask connector
 *
 * @param params - Configuration options for the MetaMask SDK
 * @returns A connector function that creates a MetaMaskConnector instance
 *
 * @example
 * ```typescript
 * const connector = metaMaskConnector({
 *   dapp: { name: 'My DApp', url: 'https://mydapp.com' },
 *   debug: true,
 * });
 * ```
 */
export const metaMaskConnector = (params?: MetaMaskConnectorSettings): ConnectorFn => {
  return ({ coreOptions, analytics }: ConnectorParams) => {
    return new MetaMaskConnector({ connectorSettings: params, coreOptions, analytics });
  };
};
