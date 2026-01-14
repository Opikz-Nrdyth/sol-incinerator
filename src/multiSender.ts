import { ethers } from "ethers";
import { TonClient, WalletContractV5R1, internal, SendMode } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import axios from "axios";
import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";

const ECPair = ECPairFactory(ecc);

// --- 1. KIRIM ETH (EVM) ---
export const sendEth = async (
  privateKey: string,
  toAddress: string,
  amountStr: string
) => {
  try {
    // Setup Provider (Jalur Koneksi)
    const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");

    // Setup Wallet (Pengirim)
    const wallet = new ethers.Wallet(privateKey, provider);

    // Cek Saldo & Gas Estimasi (Simpel)
    const feeData = await provider.getFeeData();
    const tx = {
      to: toAddress,
      value: ethers.parseEther(amountStr), // Konversi misal "0.1" jadi Wei
      gasPrice: feeData.gasPrice,
      // gasLimit akan dihitung otomatis oleh ethers
    };

    console.log(`💸 Sending ${amountStr} ETH to ${toAddress}...`);

    // Kirim!
    const transaction = await wallet.sendTransaction(tx);

    console.log("✅ ETH Sent! Hash:", transaction.hash);
    return {
      success: true,
      hash: transaction.hash,
      explorer: `https://etherscan.io/tx/${transaction.hash}`,
    };
  } catch (error: any) {
    console.error("Gagal kirim ETH:", error);
    return { success: false, error: error.message };
  }
};

// --- 2. KIRIM TON (W5) ---
export const sendTon = async (
  mnemonic: string,
  toAddress: string,
  amountStr: string
) => {
  try {
    // Setup Client (Jalur Koneksi TON)
    // Kita pakai endpoint public Toncenter
    const client = new TonClient({
      endpoint: "https://toncenter.com/api/v2/jsonRPC",
    });

    // Buka Dompet dari Mnemonic
    const keyPair = await mnemonicToWalletKey(mnemonic.split(" "));
    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    // Pastikan wallet sudah aktif (Deployed)
    if (!(await client.isContractDeployed(wallet.address))) {
      return {
        success: false,
        error: "Wallet TON belum aktif (Saldo 0 / Belum pernah terima uang)",
      };
    }

    // Buat Transfer Object
    const transfer = wallet.createTransfer({
      seqno: await wallet.getSeqno(client.provider()),
      secretKey: keyPair.secretKey,
      messages: [
        internal({
          to: toAddress,
          value: amountStr, // TON library otomatis parse string "0.5" jadi NanoTON
          bounce: false,
          body: "Sent from My Bot", // Pesan opsional
        }),
      ],
      sendMode: SendMode.PAY_GAS_SEPARATELY,
    });

    console.log(`💸 Sending ${amountStr} TON to ${toAddress}...`);

    // Broadcast!
    await client.sendExternalMessage(wallet, transfer);

    // TON tidak langsung kasih Hash, jadi kita asumsi sukses kalau tidak error
    return { success: true, message: "Transaksi dikirim! Tunggu 10-20 detik." };
  } catch (error: any) {
    console.error("Gagal kirim TON:", error);
    return { success: false, error: error.message };
  }
};

export const sendBtc = async (
  privateKeyWIF: string,
  toAddress: string,
  amountBTC: string
) => {
  try {
    const network = bitcoin.networks.bitcoin; // Mainnet
    const keyPair = ECPair.fromWIF(privateKeyWIF, network);

    // 1. Dapatkan Alamat Pengirim (Dari Private Key)
    const { address: senderAddress } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: network,
    });

    if (!senderAddress) throw new Error("Gagal generate alamat pengirim");

    console.log(`🔍 Fetching UTXOs for ${senderAddress}...`);

    // 2. Fetch UTXO (Uang Receh) dari Mempool.space
    const utxoRes = await axios.get(
      `https://mempool.space/api/address/${senderAddress}/utxo`
    );
    const utxos = utxoRes.data;

    if (utxos.length === 0)
      throw new Error("Saldo 0 atau belum terkonfirmasi (No UTXOs).");

    // 3. Hitung Target Amount (Satoshis)
    const amountSats = Math.floor(parseFloat(amountBTC) * 100_000_000);

    // 4. Estimasi Fee (Ambil "Half Hour Fee" dari mempool)
    const feeRes = await axios.get(
      "https://mempool.space/api/v1/fees/recommended"
    );
    const feeRate = feeRes.data.halfHourFee; // sat/vbyte

    // 5. Buat Transaksi (PSBT)
    const psbt = new bitcoin.Psbt({ network: network });

    let currentSats = 0;
    let byteCount = 0;
    const inputs = [];

    // Pilih UTXO yang cukup (Coin Selection Sederhana)
    for (const utxo of utxos) {
      // Mapping Data UTXO
      const input = {
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(senderAddress, "utf-8"), // Placeholder, nanti diganti otomatis oleh lib
          value: utxo.value,
        },
      };

      // Karena kita pakai P2WPKH (Native Segwit), kita butuh scriptPubKey yang benar
      const p2wpkh = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network,
      });
      input.witnessUtxo.script = p2wpkh.output!;

      psbt.addInput(input);
      inputs.push(input);

      currentSats += utxo.value;
      byteCount += 68; // Estimasi size per input (Segwit)

      if (currentSats >= amountSats) break; // Sudah cukup
    }

    // Estimasi Output size
    byteCount += 31 * 2; // 2 Output (Tujuan + Kembalian) + Overhead
    const fee = byteCount * feeRate;

    if (currentSats < amountSats + fee) {
      throw new Error(
        `Saldo kurang! Punya: ${currentSats}, Butuh: ${
          amountSats + fee
        } (termasuk fee)`
      );
    }

    // 6. Tambahkan Output (Tujuan)
    psbt.addOutput({
      address: toAddress,
      value: amountSats,
    });

    // 7. Tambahkan Output Kembalian (Change) ke diri sendiri
    const change = currentSats - amountSats - fee;
    if (change > 546) {
      // Anti-Dust (Jangan kirim kembalian kalau terlalu kecil)
      psbt.addOutput({
        address: senderAddress,
        value: change,
      });
    }

    // 8. Sign Transaksi
    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();

    // 9. Broadcast
    const txHex = psbt.extractTransaction().toHex();
    console.log(`🚀 Broadcasting BTC Tx...`);

    const pushRes = await axios.post("https://mempool.space/api/tx", txHex);

    return {
      success: true,
      hash: pushRes.data,
      explorer: `https://mempool.space/tx/${pushRes.data}`,
    };
  } catch (error: any) {
    console.error("Gagal kirim BTC:", error);
    // Error handling khusus axios
    const errMsg = error.response?.data ? error.response.data : error.message;
    return { success: false, error: errMsg };
  }
};

export const sendSol = async (
  privateKeyStr: string,
  toAddress: string,
  amountStr: string
) => {
  try {
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    // 1. Decode Keypair
    let sender: Keypair;
    if (privateKeyStr.startsWith("[") && privateKeyStr.endsWith("]")) {
      sender = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(privateKeyStr))
      );
    } else {
      sender = Keypair.fromSecretKey(bs58.decode(privateKeyStr));
    }

    // 2. Buat Transaksi
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports: parseFloat(amountStr) * LAMPORTS_PER_SOL,
      })
    );

    console.log(`💸 Sending ${amountStr} SOL to ${toAddress}...`);

    // 3. Kirim & Konfirmasi
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      sender,
    ]);

    return {
      success: true,
      hash: signature,
      explorer: `https://solscan.io/tx/${signature}`,
    };
  } catch (error: any) {
    console.error("Gagal kirim SOL:", error);
    return { success: false, error: error.message };
  }
};
