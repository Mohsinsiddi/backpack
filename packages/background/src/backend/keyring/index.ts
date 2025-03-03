import type { KeyringStoreState } from "@coral-xyz/recoil";
import { KeyringStoreStateEnum } from "@coral-xyz/recoil";
import type { EventEmitter, DerivationPath } from "@coral-xyz/common";
import {
  Blockchain,
  EthereumExplorer,
  EthereumConnectionUrl,
  SolanaExplorer,
  SolanaCluster,
  NOTIFICATION_KEYRING_STORE_LOCKED,
  BACKEND_EVENT,
  BACKPACK_FEATURE_MULTICHAIN,
} from "@coral-xyz/common";
import * as crypto from "./crypto";
import { SolanaHdKeyringFactory } from "./solana";
import * as store from "../store";
import { DefaultKeyname, DEFAULT_DARK_MODE } from "../store";
import { BlockchainKeyring } from "./blockchain";

/**
 * Keyring API for managing all wallet keys.
 */
export class KeyringStore {
  private blockchains: Map<string, BlockchainKeyring>;
  private lastUsedTs: number;
  private password?: string;
  private autoLockInterval?: ReturnType<typeof setInterval>;
  private events: EventEmitter;
  private mnemonic: string;

  constructor(events: EventEmitter) {
    this.blockchains = new Map();
    this.lastUsedTs = 0;
    this.events = events;
  }

  public async state(): Promise<KeyringStoreState> {
    if (this.isUnlocked()) {
      return KeyringStoreStateEnum.Unlocked;
    }
    if (await this.isLocked()) {
      return KeyringStoreStateEnum.Locked;
    }
    return KeyringStoreStateEnum.NeedsOnboarding;
  }

  // Initializes the keystore for the first time.
  public async init(
    mnemonic: string,
    derivationPath: DerivationPath,
    password: string,
    accountIndices: Array<number>,
    username: string
  ) {
    this.password = password;
    this.mnemonic = mnemonic;

    // Init Solana
    const keyring = await this.initBlockchainKeyring(
      derivationPath,
      accountIndices,
      Blockchain.SOLANA
    );

    if (BACKPACK_FEATURE_MULTICHAIN) {
      // Init Ethereum
      await this.initBlockchainKeyring(
        derivationPath,
        accountIndices,
        Blockchain.ETHEREUM
      );
    }

    // Persist the initial wallet ui metadata.
    await store.setWalletData({
      username,
      autoLockSecs: store.DEFAULT_LOCK_INTERVAL_SECS,
      approvedOrigins: [],
      darkMode: DEFAULT_DARK_MODE,
      solana: {
        explorer: SolanaExplorer.DEFAULT,
        cluster: SolanaCluster.DEFAULT,
        commitment: "confirmed",
      },
      ethereum: {
        explorer: EthereumExplorer.DEFAULT,
        connectionUrl: EthereumConnectionUrl.DEFAULT,
      },
    });

    // Persist the encrypted data to then store.
    await this.persist(true);

    // Automatically lock the store when idle.
    await this.tryUnlock(password);

    return keyring;
  }

  // Initialise a blockchain keyring.
  public async initBlockchainKeyring(
    derivationPath: DerivationPath,
    accountIndices: Array<number>,
    blockchain: Blockchain
  ): Promise<BlockchainKeyring> {
    const keyring = {
      [Blockchain.SOLANA]: BlockchainKeyring.solana,
      [Blockchain.ETHEREUM]: BlockchainKeyring.ethereum,
    }[blockchain]();
    await keyring.init(this.mnemonic, derivationPath, accountIndices);
    this.blockchains.set(blockchain, keyring);
    return keyring;
  }

  public async checkPassword(password: string) {
    try {
      await this.decryptKeyringFromStorage(password);
      return true;
    } catch (err) {
      return false;
    }
  }

  public async tryUnlock(password: string) {
    return this.withLock(async () => {
      const plaintext = await this.decryptKeyringFromStorage(password);
      this.fromJson(JSON.parse(plaintext));
      this.password = password;
      // Automatically lock the store when idle.
      this.autoLockStart();
    });
  }

  private async decryptKeyringFromStorage(password: string) {
    const ciphertextPayload = await store.getEncryptedKeyring();
    if (ciphertextPayload === undefined || ciphertextPayload === null) {
      throw new Error("keyring store not found on disk");
    }
    const plaintext = await crypto.decrypt(ciphertextPayload, password);
    return plaintext;
  }

  public lock() {
    this.blockchains = new Map();
    this.lastUsedTs = 0;
  }

  // Return the public keys of all blockchain keyrings in the keyring.
  public publicKeys(): {
    [key: string]: {
      hdPublicKeys: Array<string>;
      importedPublicKeys: Array<string>;
      ledgerPublicKeys: Array<string>;
    };
  } {
    return this.withUnlock(() => {
      const entries = Array.from(this.blockchains).map(
        ([blockchain, keyring]) => {
          return [blockchain, keyring.publicKeys()];
        }
      );
      return Object.fromEntries(entries);
    });
  }

  // Preview public keys for a given mnemonic and derivation path without
  // importing the mnemonic.
  public previewPubkeys(
    mnemonic: string,
    derivationPath: DerivationPath,
    numberOfAccounts: number
  ): string[] {
    const factory = new SolanaHdKeyringFactory();
    const hdKeyring = factory.fromMnemonic(mnemonic, derivationPath, [
      ...Array(numberOfAccounts).keys(),
    ]);
    return [...Array(numberOfAccounts).keys()].map((i) =>
      hdKeyring.getPublicKey(i)
    );
  }

  // Derive the next key for the given blockchain.
  public async deriveNextKey(
    blockchain: Blockchain
  ): Promise<[string, string]> {
    return this.withUnlock(async () => {
      let blockchainKeyring = this.blockchains.get(blockchain);
      if (!blockchainKeyring) {
        throw new Error("blockchain keyring not initialised");
      } else {
        // Derive the next key.
        const [pubkey, name] = blockchainKeyring.deriveNextKey();
        this.persist();
        return [pubkey, name];
      }
    });
  }

  // Import a secret key for the given blockchain.
  // TODO handle initialisation, allow init blockchain without mnemonic?
  public async importSecretKey(
    blockchain: Blockchain,
    secretKey: string,
    name: string
  ): Promise<[string, string]> {
    return this.withUnlock(async () => {
      const keyring = this.keyringForBlockchain(blockchain);
      const [publicKey, _name] = await keyring.importSecretKey(secretKey, name);
      this.persist();
      return [publicKey, _name];
    });
  }

  public async passwordUpdate(currentPassword: string, newPassword: string) {
    return this.withPassword(currentPassword, () => {
      this.password = newPassword;
      this.persist();
    });
  }

  public exportSecretKey(password: string, publicKey: string): string {
    return this.withPassword(password, () => {
      const keyring = this.keyringForPublicKey(publicKey);
      return keyring.exportSecretKey(publicKey);
    });
  }

  public exportMnemonic(password: string): string {
    return this.withPassword(password, () => {
      return this.mnemonic;
    });
  }

  public reset() {
    // First lock to clear the keyring memory.
    this.lock();
    // Then reset persistent disk storage.
    return store.reset();
  }

  public async autoLockUpdate(autoLockSecs: number) {
    return await this.withUnlock(async () => {
      const data = await store.getWalletData();
      await store.setWalletData({
        ...data,
        autoLockSecs,
      });

      if (this.autoLockInterval) {
        clearInterval(this.autoLockInterval);
      }
      this.autoLockStart();
    });
  }

  public async keyDelete(blockchain: Blockchain, pubkey: string) {
    return this.withUnlock(async () => {
      const blockchainKeyring = this.blockchains.get(blockchain);
      await blockchainKeyring!.keyDelete(pubkey);
      await this.persist();
    });
  }

  public keepAlive() {
    return this.withUnlock(() => {});
  }

  public async ledgerImport(
    blockchain: Blockchain,
    dPath: string,
    account: number,
    pubkey: string
  ) {
    return this.withUnlock(async () => {
      const blockchainKeyring = this.blockchains.get(blockchain);
      const ledgerKeyring = blockchainKeyring!.ledgerKeyring!;
      const name = DefaultKeyname.defaultLedger(ledgerKeyring.keyCount());
      await ledgerKeyring.ledgerImport(dPath, account, pubkey);
      await store.setKeyname(pubkey, name);
      await this.persist();
    });
  }

  public createMnemonic(strength: number): string {
    const factory = new SolanaHdKeyringFactory();
    const kr = factory.generate(strength);
    return kr.mnemonic;
  }

  private toJson(): any {
    // toJson on all the keyrings
    const blockchains = Object.fromEntries(
      [...this.blockchains].map(([k, v]) => [k, v.toJson()])
    );
    return {
      mnemonic: this.mnemonic,
      blockchains,
      lastUsedTs: this.lastUsedTs,
    };
  }

  private fromJson(json: any) {
    const { mnemonic, blockchains } = json;
    this.mnemonic = mnemonic;
    this.blockchains = new Map(
      Object.entries(blockchains).map(([blockchain, obj]) => {
        const blockchainKeyring = BlockchainKeyring[blockchain]();
        blockchainKeyring.fromJson(obj);
        return [blockchain, blockchainKeyring];
      })
    );
  }

  private async isLocked(): Promise<boolean> {
    if (this.isUnlocked()) {
      return false;
    }
    const ciphertext = await store.getEncryptedKeyring();
    return ciphertext !== undefined && ciphertext !== null;
  }

  private isUnlocked(): boolean {
    return this.lastUsedTs !== 0;
  }

  private async persist(forceBecauseCalledFromInit = false) {
    if (!forceBecauseCalledFromInit && !this.isUnlocked()) {
      throw new Error("attempted persist of locked keyring");
    }
    const plaintext = JSON.stringify(this.toJson());
    const ciphertext = await crypto.encrypt(plaintext, this.password!);
    await store.setEncryptedKeyring(ciphertext);
  }

  private autoLockStart() {
    // Check the last time the keystore was used at a regular interval.
    // If it hasn't been used recently, lock the keystore.
    store.getWalletData().then(({ autoLockSecs }) => {
      const _autoLockSecs = autoLockSecs ?? store.DEFAULT_LOCK_INTERVAL_SECS;
      this.autoLockInterval = setInterval(() => {
        const currentTs = Date.now() / 1000;
        if (currentTs - this.lastUsedTs >= _autoLockSecs) {
          this.lock();
          this.events.emit(BACKEND_EVENT, {
            name: NOTIFICATION_KEYRING_STORE_LOCKED,
          });
          if (this.autoLockInterval) {
            clearInterval(this.autoLockInterval);
          }
        }
      }, _autoLockSecs * 1000);
    });
  }

  // Utility for asserting the wallet is currently unlocked.
  private withUnlock<T>(fn: () => T) {
    if (!this.isUnlocked()) {
      throw new Error("keyring store is not unlocked");
    }
    const resp = fn();
    this.updateLastUsed();
    return resp;
  }

  // Utility for asserting the wallet is currently locked.
  private withLock<T>(fn: () => T): T {
    if (this.isUnlocked()) {
      throw new Error("keyring store is not locked");
    }
    const resp = fn();
    this.updateLastUsed();
    return resp;
  }

  // Utility for asserting the wallet is unlocked and the correct password was
  // given.
  private withPassword<T>(currentPassword: string, fn: () => T) {
    return this.withUnlock(() => {
      if (currentPassword !== this.password) {
        throw new Error("incorrect password");
      }
      return fn();
    });
  }

  private updateLastUsed() {
    this.lastUsedTs = Date.now() / 1000;
  }

  /**
   * Return all the active public keys for all enabled blockchains.
   */
  public async activeWallets(): Promise<string[]> {
    return this.withUnlock(async () => {
      return [...this.blockchains.values()]
        .map((bc) => bc.getActiveWallet())
        .filter((w) => w !== undefined) as string[];
    });
  }

  /**
   * Update the active public key for the given blockchain.
   */
  public async activeWalletUpdate(
    newActivePublicKey: string,
    blockchain: Blockchain
  ) {
    return this.withUnlock(async () => {
      const keyring = this.keyringForBlockchain(blockchain);
      await keyring.activeWalletUpdate(newActivePublicKey);
      await this.persist();
    });
  }

  /**
   * Returns the blockchain for a given public key.
   */
  public blockchainForPublicKey(publicKey: string): Blockchain {
    for (const [blockchain, keyring] of this.blockchains) {
      if (keyring.hasPublicKey(publicKey)) {
        return blockchain as Blockchain;
      }
    }
    throw new Error("no blockchain for public key");
  }

  /**
   * Returns the keyring for a given blockchain.
   */
  public keyringForBlockchain(blockchain: Blockchain): BlockchainKeyring {
    const keyring = this.blockchains.get(blockchain);
    if (keyring) {
      return keyring;
    }
    throw new Error("no keyring for blockchain");
  }

  /**
   * Returns the keyring for a given public key.
   */
  public keyringForPublicKey(publicKey: string): BlockchainKeyring {
    for (const keyring of this.blockchains.values()) {
      if (keyring.hasPublicKey(publicKey)) {
        return keyring;
      }
    }
    throw new Error("no keyring for public key");
  }
}
