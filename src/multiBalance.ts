import { ethers } from "ethers";
import axios from "axios";
import { TonClient4, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
dotenv.config();

const SOL_RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOL_RPC, "confirmed");

// 1. Cek Saldo ETH
export const getEthBalance = async (privateKey: string) => {
  try {
    // Pakai Public RPC gratis yang stabil
    const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    return {
      address: wallet.address,
      balance: ethers.formatEther(balance), // Konversi Wei ke ETH
    };
  } catch (e) {
    return { address: "Error", balance: "0" };
  }
};

// 2. Cek Saldo BTC
export const getBtcBalance = async (address: string) => {
  try {
    // Menggunakan API mempool.space (No Auth needed)
    const res = await axios.get(`https://mempool.space/api/address/${address}`);
    const chainStats = res.data.chain_stats;
    const satoshis = chainStats.funded_txo_sum - chainStats.spent_txo_sum;
    return {
      address: address,
      balance: (satoshis / 100_000_000).toFixed(8), // Konversi Satoshi ke BTC
    };
  } catch (e) {
    return { address: address, balance: "0" };
  }
};

// 3. Cek Saldo TON
export const getTonBalance = async (mnemonic: string) => {
  try {
    const keyPair = await mnemonicToWalletKey(mnemonic.split(" "));
    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });
    const address = wallet.address.toString({
      testOnly: false,
      urlSafe: true,
      bounceable: false,
    });

    // Request ke API TonAPI / Toncenter (Versi HTTP Request sederhana)
    const res = await axios.get(
      `https://toncenter.com/api/v2/getAddressBalance?address=${address}`
    );

    if (res.data.ok) {
      return {
        address: address,
        balance: (Number(res.data.result) / 1_000_000_000).toFixed(4),
      };
    }
    return { address: address, balance: "0" };
  } catch (e) {
    return { address: "Error", balance: "0" };
  }
};

export const getSolBalance = async (privateKeyStr: string) => {
  try {
    let keypair: Keypair;

    // Logika Auto-Detect Format Key (Array vs Base58)
    if (privateKeyStr.startsWith("[") && privateKeyStr.endsWith("]")) {
      keypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(privateKeyStr))
      );
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(privateKeyStr));
    }

    const balance = await connection.getBalance(keypair.publicKey);

    return {
      address: keypair.publicKey.toBase58(),
      balance: (balance / LAMPORTS_PER_SOL).toString(),
    };
  } catch (e) {
    return { address: "Error", balance: "0" };
  }
};
